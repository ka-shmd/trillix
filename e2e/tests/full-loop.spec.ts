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

test('регистрация → форма → публикация → ответ (мобильный) → таблица → CSV', async ({
  page,
  browser,
}) => {
  const uniq = Date.now()
  const email = `e2e-${uniq}@example.com`
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

  // 3. Один вопрос через слэш-редактор (сигнатурный UX). Заголовок формы не
  // переименовываем: rename двигает updated_at формы, а автосейв схемы держит свой
  // токен оптимистичной блокировки — быстрый rename+правка ловят 409 (гонка билдера,
  // вне scope фазы 7). Enter в (пустом) заголовке просто создаёт первую строку-блок.
  await page.getByLabel('Название формы').press('Enter')
  await page.getByPlaceholder('Текст, или «/» для поля').press('/')
  await page.getByRole('option', { name: 'Короткий ответ' }).click()
  await page.getByPlaceholder('Введите текст вопроса').fill(question)

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

  // 7. Ответ виден в таблице кабинета.
  await page.goto(`/forms/${formId}/responses`)
  await expect(page.getByText(answer)).toBeVisible()

  // 8. Экспорт CSV — обычная навигация на эндпоинт, браузер качает файл.
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Экспорт CSV' }).click()
  const download = await downloadPromise
  const csv = readFileSync(await download.path(), 'utf8')
  expect(csv).toContain(question) // колонка вопроса
  expect(csv).toContain(answer) // значение ответа
})
