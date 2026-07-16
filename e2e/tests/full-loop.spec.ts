import { readFileSync } from 'node:fs'
import { test, expect, devices } from '@playwright/test'

// Единственный сквозной сценарий (ARCHITECTURE §8): регистрация → собрать форму
// слэш-редактором → опубликовать → ответить с мобильного → увидеть в таблице →
// скачать CSV. Гоняет собранный продукт в реальном браузере против prod-local —
// закрывает дыру, которую не видят ни Go-, ни vitest-тесты (баги «прод-сборка ≠
// dev»: пустая форма без entry, форма без стилей — оба ловятся здесь).
//
// Публичная база рендерера берётся из окружения (в prod-local — https://f.localhost),
// чтобы тест не был привязан к конкретному хосту.
const RENDERER = process.env.E2E_RENDERER_URL ?? 'https://f.localhost'

// Валидная маленькая PNG (2×2) для загрузки картинки блока — setInputFiles умеет
// принимать буфер, поэтому фикстура-файл не нужна. Важно: с корректными CRC чанков —
// сервер делает полный image.Decode (не только заголовок), битый CRC → 422. Байты
// сгенерированы image/png (Go) и проверены декодом. Сервер её пере-кодирует и кладёт
// в бакет; форма грузит обратно с /media (Caddy→MinIO) — сквозная проверка медиа.
const PNG_2x2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR4nGI5ERDAwMDAxAAGgAAAAP//EawBb2yaraEAAAAASUVORK5CYII=',
  'base64',
)

test('регистрация → форма → публикация → ответ (мобильный) → таблица → CSV', async ({
  page,
  browser,
}) => {
  const uniq = Date.now()
  const email = `e2e-${uniq}@example.com`
  const formTitle = `Опрос ${uniq}`
  const question = 'Ваше имя'
  const answer = `Иван ${uniq}`

  // 1. Регистрация (создаёт сессию, cookie Secure по https). После успеха приложение
  // само уводит на дашборд — дожидаемся навигации, а не гоним goto в гонку с POST.
  await page.goto('/register')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Пароль').fill('supersecret123')
  await page.getByRole('button', { name: 'Создать аккаунт' }).click()
  await page.waitForURL('**/forms')

  // 2. Новая форма → редактор (кнопок «Новая форма» несколько — сайдбар/шапка/
  // дашборд; любая создаёт форму). Запоминаем id из URL.
  await page.getByRole('button', { name: 'Новая форма' }).first().click()
  await expect(page).toHaveURL(/\/forms\/[^/]+\/edit/)
  const formId = page.url().match(/\/forms\/([^/]+)\/edit/)![1]

  // 3. Переименовываем заголовок и СРАЗУ добавляем вопрос — тот самый сценарий,
  // что вскрывал гонку оптимистичной блокировки (rename двигал updated_at, автосейв
  // схемы уходил со старым токеном → 409, «Опубликовать» залипала disabled). После
  // фикса (единый токен из кэша detail) быстрый rename+правка проходят. Enter в
  // заголовке уводит на первую строку-блок.
  await page.getByLabel('Название формы').fill(formTitle)
  await page.getByLabel('Название формы').press('Enter')
  await page.getByPlaceholder('Текст, или «/» для поля').press('/')
  await page.getByRole('option', { name: 'Короткий ответ' }).click()
  await page.getByPlaceholder('Введите текст вопроса').fill(question)

  // 3b. Лейаут-блок «Картинка» через «+ Добавить блок» → диалог типов (единственная
  // модалка — без гонки слэш-меню). Грузим PNG в скрытый input. После загрузки
  // локальный превью сменяется реальным src /media/<key> — это подтверждает, что
  // аплоад дошёл до бакета и билдер получил ключ (который автосейв положит в схему).
  await page.getByRole('button', { name: '+ Добавить блок' }).click()
  await page.getByRole('button', { name: 'Картинка', exact: true }).click()
  await page.getByRole('button', { name: 'Добавить', exact: true }).click()
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: PNG_2x2 })
  await expect(page.locator('img.rf-image')).toHaveAttribute('src', /\/media\//, { timeout: 15000 })

  // 4. Публикация: кнопка активна, только когда автосейв догнал редактор.
  const publish = page.getByRole('button', { name: 'Опубликовать' })
  await expect(publish).toBeEnabled()
  await publish.click()
  await expect(page).toHaveURL(/\/forms\/[^/]+\/share/)

  // 5. Ссылка на опубликованную форму — из readonly-поля страницы «Поделиться».
  const link = await page.locator('input[readonly]').first().inputValue()
  expect(link).toContain('/r/')

  // 6. Ответ с МОБИЛЬНОГО и АНОНИМНОГО контекста (респондент без сессии кабинета).
  const mobile = await browser.newContext({
    ...devices['Pixel 5'],
    ignoreHTTPSErrors: true,
    baseURL: RENDERER,
  })
  const form = await mobile.newPage()
  await form.goto(link)

  // Регресс «пустая форма» (нет entry-скрипта) → поле вопроса не отрендерится.
  const field = form.getByLabel(question)
  await expect(field).toBeVisible()

  // Картинка блока отрендерилась и реально загрузилась с /media (Caddy→бакет):
  // naturalWidth > 0 значит браузер её получил и декодировал (не битый src).
  const formImage = form.locator('img.rf-image')
  await expect(formImage).toBeVisible()
  await expect
    .poll(() => formImage.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 10000 })
    .toBeGreaterThan(0)

  // Регресс «форма без стилей» (нет <link> на CSS) → у кнопки не будет фона.
  const submitBg = await form
    .locator('button.rf-submit')
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(submitBg).not.toBe('rgba(0, 0, 0, 0)')
  expect(submitBg).not.toBe('transparent')

  await field.fill(answer)
  // Антиспам (фаза 5): отправка быстрее DefaultMinFillTime (3с) от выдачи формы
  // отклоняется как бот. Настоящий респондент столько и заполняет — выжидаем.
  await form.waitForTimeout(3500)
  await form.locator('button.rf-submit').click()
  await expect(form.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()
  await mobile.close()

  // 7. Ответ виден в таблице кабинета. Заголовок «Ответы · <name>» подтверждает, что
  // переименование заголовка долетело до сервера (регресс гонки блокировки из шага 3).
  await page.goto(`/forms/${formId}/responses`)
  await expect(page.getByRole('heading', { name: `Ответы · ${formTitle}` })).toBeVisible()
  // В таблице только версия и дата — сам ответ смотрим в диалоге полного ответа.
  await page.getByRole('button', { name: 'Открыть' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(answer)).toBeVisible()
  await page.keyboard.press('Escape') // закрыть диалог: оверлей перекрывает ссылку экспорта
  await expect(page.getByRole('dialog')).toBeHidden()

  // 8. Экспорт CSV — обычная навигация на эндпоинт, браузер качает файл.
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Экспорт CSV' }).click()
  const download = await downloadPromise
  const csv = readFileSync(await download.path(), 'utf8')
  expect(csv).toContain(question) // колонка вопроса
  expect(csv).toContain(answer) // значение ответа
})
