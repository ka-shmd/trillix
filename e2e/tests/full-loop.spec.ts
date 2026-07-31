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

// Командный модификатор карты шорткатов (`mod` в builder/shortcuts.ts): Cmd на маке,
// Ctrl на остальных. Здесь нужен ровно один — отмена документа (Mod+Z).
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

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
  const scaleQuestion = 'Насколько удобно'
  const scaleAnswer = '4' // деление шкалы: дефолтный диапазон 1–5 (DEFAULT_SCALE_MIN/MAX)
  const consentText = 'Согласен на обработку данных'

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
  // Строки полотна берутся ПО ИМЕНИ роли textbox, а не по плейсхолдеру: с этапа 14.3
  // текстовая строка — contenteditable (богатый текст), а `placeholder` есть только у
  // настоящих <input>/<textarea>. Имя строки задаёт `aria-label` (`RichLine`) — оно же
  // и то, что слышит скринридер, поэтому селектор проверяет доступность заодно.
  //
  // Подсказка пустой строки контекстная (фаза 13.5): в первой строке формы она зовёт
  // добавить вопрос, ниже по полотну — поле. Берём общую часть регуляркой, чтобы
  // сценарий не зависел от позиции строки.
  await page.getByRole('textbox', { name: /^Текст, или «\/»/ }).press('/')
  // Один и тот же тип есть в ДВУХ разделах меню — «Вопросы» (связка подпись+поле) и
  // «Отдельные поля» (голый инпут), поэтому локатор по имени неоднозначен. Нам нужна
  // связка: ниже заполняется подпись вопроса, у голого поля её нет. Раздел в
  // селекторе больше не назвать — инлайн-меню после TD-33 (фаза 13.2) стало поповером
  // со списком (`role="listbox"`), где заголовки разделов — обычный текст, а не
  // именованные группы (они остались только в богатом диалоге «+», ниже). Порядок
  // MENU_ITEMS (вопросы → отдельные поля → лэйаут) гарантирован filterMenuItems,
  // поэтому связка — первое совпадение.
  await page.getByRole('option', { name: 'Короткий ответ' }).first().click()
  // Подпись вопроса — ОТДЕЛЬНЫЙ блок `title` (фаза 8.7: «вопрос = группа блоков»),
  // его имя «Заголовок вопроса». Прежний «Введите текст вопроса» исчез вместе со
  // старой моделью «подпись — свойство поля».
  await page.getByRole('textbox', { name: 'Заголовок вопроса' }).fill(question)

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

  // 3c. Шкала и согласие (фаза 8.5, шаг 2) — через тот же диалог типов, а не слэш-меню.
  // ЗАЧЕМ ЗДЕСЬ: DoD фазы требует, чтобы каждый новый тип прошёл полный цикл
  // (билдер → публикация → ответ → таблица → CSV). Go- и vitest-тесты держат контракт
  // обеих сторон, но НЕ проверяют, что контрол вообще отрисуется в прод-сборке: у
  // шкалы это ряд кнопок, у согласия — галочка, и оба берут вид из общего fields.css.
  // Класс бага «форма без стилей» ловится именно так.
  await page.getByRole('button', { name: '+ Добавить блок' }).click()
  // Группа обязательна: тот же тип поля есть и в «Вопросы» (связка с заголовком),
  // и в «Отдельные поля» (голый инпут) — без неё локатор неоднозначен. Здесь нужна
  // связка: ниже заполняется «Заголовок вопроса».
  await page
    .getByRole('group', { name: 'Вопросы' })
    .getByRole('button', { name: 'Шкала', exact: true })
    .click()
  await page.getByRole('button', { name: 'Добавить', exact: true }).click()
  // Имя подписи общее с первым вопросом — берём последний добавленный.
  await page.getByRole('textbox', { name: 'Заголовок вопроса' }).last().fill(scaleQuestion)

  // 3c-бис. ФАЗА 16, этап 16.3: диапазон шкалы правится в ПОПАПЕ настроек, а не на
  // полотне — на полотне остаётся только то, что увидит респондент. Дорожка проходит
  // ровно по границе «браузер ↔ наш код», на которой юниты слепы: два жеста на одной
  // ручке (клик — настройки, перетаскивание — перенос) и Radix-Select внутри
  // Radix-поповера. Меняем конец шкалы на 7 и проверяем, что деления на полотне
  // пересчитались.
  const scaleRow = page.locator('[data-block-id]').filter({ has: page.getByRole('group') }).last()
  await scaleRow.hover()
  await scaleRow.getByRole('button', { name: 'Настройки блока' }).click()
  const settingsPopup = page.locator('[data-slot="popover-content"]')
  await settingsPopup.getByRole('combobox', { name: 'Конец шкалы' }).click()
  await page.getByRole('option', { name: '7', exact: true }).click()
  await page.keyboard.press('Escape')
  // Деления шкалы — кнопки внутри её группы НА ПОЛОТНЕ: было пять (1–5), стало семь.
  // Считаем внутри строки, а не по имени вопроса: у одной и той же роли `group` имена
  // на двух поверхностях разные. На странице респондента BlockField берёт в aria-label
  // подпись вопроса (ниже так и ищем), а на полотне BlockControl подписи не знает —
  // там имя вырождается в «Поле». Локатор по имени вопроса на полотне не находит
  // ничего и падает по таймауту.
  await expect(scaleRow.getByRole('group').getByRole('button')).toHaveCount(7)

  // У согласия своё имя строки: текст согласия правится строкой заголовка, потому
  // что он и есть label блока (галочка слева — как у респондента).
  await page.getByRole('button', { name: '+ Добавить блок' }).click()
  // Согласию заголовок не нужен: его текст И ЕСТЬ подпись блока (правится строкой
  // ниже), поэтому берём голое поле — иначе на полотне остался бы пустой заголовок.
  await page
    .getByRole('group', { name: 'Отдельные поля' })
    .getByRole('button', { name: 'Согласие', exact: true })
    .click()
  await page.getByRole('button', { name: 'Добавить', exact: true }).click()
  await page.getByRole('textbox', { name: 'Текст согласия' }).fill(consentText)

  // 3d. ФАЗА 15, мышиная сторона: у СТРОКИ ОТВЕТА собранного вопроса есть свой кластер
  // значков, и её мусорка значит «эта строка», а не «вопрос целиком». До фазы у такой
  // строки кластера не было вовсе (замок `ownedByCaption`): считалось, что действий,
  // которых не бывает, показывать нельзя. Теперь бывает — и вопрос без поля законно
  // распадается на текст, а Mod+Z возвращает всё назад.
  //
  // Проверяем на ПЕРВОМ вопросе (короткий ответ): наводим мышь на его поле, жмём
  // мусорку строки — подпись остаётся, поле исчезает; откатываем.
  const canvasRows = page.locator('[data-block-id]')
  const rowsBefore = await canvasRows.count()
  const firstAnswer = canvasRows.nth(1) // 0 — подпись первого вопроса, 1 — его поле
  await firstAnswer.hover()
  const rowTrash = firstAnswer.getByRole('button', { name: 'Удалить блок' })
  await expect(rowTrash).toBeVisible()
  await rowTrash.click()
  await expect(canvasRows).toHaveCount(rowsBefore - 1)
  // Подпись пережила удаление поля: удалили СТРОКУ, а не вопрос.
  await expect(page.getByRole('textbox', { name: 'Заголовок вопроса' }).first()).toHaveText(question)
  // Откат — тем же стеком документа (слушатель на весь экран билдера).
  await page.keyboard.press(`${MOD}+KeyZ`)
  await expect(canvasRows).toHaveCount(rowsBefore)

  // 3e. ФАЗА 16, этап 16.5: гейт публикации. Недособранный вопрос форму не пускает, и
  // кабинет говорит, ЧТО именно мешает, — до нажатия, а не отказом сервера. Дорожка
  // снова проходит по границе «браузер ↔ наш код»: список считается по живому стору,
  // а показывается в Radix-поповере, и юниты этой половины не видят.
  //
  // Добавляем вопрос и НЕ заполняем заголовок: два блокера на одном вопросе (пустая
  // подпись и безымянное поле). Возвращаемся одним Mod+Z — вставка вопроса-бандла это
  // один шаг истории.
  await page.getByRole('button', { name: '+ Добавить блок' }).click()
  await page
    .getByRole('group', { name: 'Вопросы' })
    .getByRole('button', { name: 'Короткий ответ', exact: true })
    .click()
  await page.getByRole('button', { name: 'Добавить', exact: true }).click()

  const publish = page.getByRole('button', { name: 'Опубликовать' })
  await expect(publish).toBeDisabled()
  await page.getByRole('button', { name: 'Что мешает (2)' }).click()
  const reasons = page.locator('[data-slot="popover-content"]').getByRole('button')
  await expect(reasons).toHaveCount(2)
  // Причина — это адрес: клик уводит каретку на строку блока (§12 EDITOR.md).
  await reasons.first().click()
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0)

  await page.keyboard.press(`${MOD}+KeyZ`)
  await expect(page.getByRole('button', { name: /Что мешает/ })).toHaveCount(0)

  // 4. Публикация: кнопка активна, только когда автосейв догнал редактор И форма
  // собрана (гейт выше).
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

  // Шкала: настоящие <button> с aria-pressed (не radio), сгруппированы role="group"
  // с aria-label вопроса. Нажатие сразу даёт значение — проверяем, что деление
  // действительно встало выбранным, иначе в ответ уехала бы пустая строка.
  const scale = form.getByRole('group', { name: scaleQuestion })
  await scale.getByRole('button', { name: scaleAnswer, exact: true }).click()
  await expect(scale.getByRole('button', { name: scaleAnswer, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // Согласие обязательно у нового блока (флаг required включён по умолчанию),
  // поэтому без галочки отправка не прошла бы — это же и проверка, что чекбокс жив.
  const consent = form.getByRole('checkbox')
  await consent.check()

  // Антиспам (фаза 5): отправка быстрее DefaultMinFillTime (3с) от выдачи формы
  // отклоняется как бот. Настоящий респондент столько и заполняет — выжидаем.
  await form.waitForTimeout(3500)
  await form.locator('button.rf-submit').click()
  await expect(form.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()
  await mobile.close()

  // 7. Ответ виден в таблице кабинета. Название формы в шапке подтверждает, что
  // переименование заголовка долетело до сервера (регресс гонки блокировки из шага 3).
  // Шапка общая на три экрана формы и живёт в оболочке `_manage` (фаза 8.5, шаг 3):
  // «Ответы» здесь — таб-ссылка, а не часть заголовка.
  await page.goto(`/forms/${formId}/responses`)
  await expect(page.getByRole('heading', { name: formTitle })).toBeVisible()
  // В таблице только версия и дата — сам ответ смотрим в диалоге полного ответа.
  await page.getByRole('button', { name: 'Открыть' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(answer)).toBeVisible()
  // Значение шкалы в диалоге — точное совпадение: `toContain('4')` по CSV поймал бы
  // любую четвёрку в дате ответа и ничего бы не доказывал.
  await expect(dialog.getByText(scaleQuestion)).toBeVisible()
  await expect(dialog.getByText(scaleAnswer, { exact: true })).toBeVisible()
  await page.keyboard.press('Escape') // закрыть диалог: оверлей перекрывает ссылку экспорта
  await expect(page.getByRole('dialog')).toBeHidden()

  // 8. Экспорт CSV — обычная навигация на эндпоинт, браузер качает файл.
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Экспорт CSV' }).click()
  const download = await downloadPromise
  const csv = readFileSync(await download.path(), 'utf8')
  expect(csv).toContain(question) // колонка вопроса
  expect(csv).toContain(answer) // значение ответа

  // Новые типы доехали до выгрузки колонками и значениями (замыкает цикл DoD).
  // Согласие в CSV — человеческое «Да», а не внутреннее «yes»: внутренняя кодировка
  // владельцу не показывается (domain/csv.go).
  expect(csv).toContain(scaleQuestion)
  expect(csv).toContain(consentText)
  expect(csv).toContain('Да')
})
