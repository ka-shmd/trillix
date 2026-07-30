import { test, expect, devices, type Locator } from '@playwright/test'
import { login, seedAccount } from './helpers/session'

// «Билдер без мыши» (фаза 13, этап 13.7) — сквозной критерий реворка полотна: форма
// собирается ОДНОЙ КЛАВИАТУРОЙ, публикуется и доезжает до респондента.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СЦЕНАРИЙ, а не дописать в full-loop: тот ходит по билдеру мышью
// (слеш-меню кликом, диалог типов кликом) и проверяет ДРУГОЕ — что каждый тип блока
// проходит полный цикл до CSV. Здесь предмет один: клавиатурный поток полотна. Если
// смешать, падение перестанет называть подсистему.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ ВПЕРВЫЕ (юниты этого не видят):
//   1. Клавиатурный поток целиком в ПРОД-СБОРКЕ: Enter из названия → «/» + фильтр +
//      Enter (инлайн-меню типов, TD-33) → Enter между вопросами → Mod+Enter к полю
//      ответа → Enter в списке вариантов. vitest держит контракт фокуса на happy-dom,
//      но не то, что собранное приложение отдаёт те же поверхности.
//   2. Ряд из двух вопросов (§5 спеки, этап 13.6) от клавиши до респондента: бит
//      `column` пережил автосейв, снапшот версии при публикации и рендерер.
//   3. Мобильный столбик ряда — медиазапрос `.rf-row` живёт в общем fields.css, и
//      только прод-сборка доказывает, что CSS доехал.
//   4. ФАЗА 15 «Свобода блока», её сквозной критерий целиком: заголовок формы правится
//      как обычная строка полотна (разметка `Mod+B`, откат `Mod+Z` тем же стеком) и
//      доезжает до респондента, а `<title>` остаётся плоским; двухколоночная СЕКЦИЯ
//      собирается осью `Mod+Alt+←/→` и держит стопку в колонке; `Enter` из колонки
//      кладёт новую строку ПОД секцией, а не между колонками; подпись и поле встают в
//      ряд ВНУТРИ вопроса. Всё это модель проверяет юнитами, но «доехало до прод-сборки
//      и нарисовано» — только здесь.
//
// СЕССИЯ — не UI-регистрацией: `registerBurst` расходуется тремя старыми сценариями
// в ноль (см. helpers/session.ts). Форма создаётся запросом к API: предмет теста —
// полотно, а не кнопка «Новая форма» (её ход держит full-loop).
const RENDERER = process.env.E2E_RENDERER_URL ?? 'https://f.localhost'

// Командный модификатор карты шорткатов (`mod` в builder/shortcuts.ts): Cmd на маке,
// Ctrl на остальных. CI — ubuntu, локальный прогон бывает и на маке.
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

// sideBySide — «эти двое стоят в одном ряду»: одна высота и второй правее первого.
// Ряд проверяется геометрией на всех поверхностях, потому что разметка у них РАЗНАЯ
// (у полотна своя раскладка flex-wrap, у респондента общий `.rf-row`), а совпасть
// они обязаны видом. Допуск по вертикали — на разную высоту строк подписи.
async function sideBySide(left: Locator, right: Locator): Promise<boolean> {
  const a = await left.boundingBox()
  const b = await right.boundingBox()
  if (!a || !b) return false
  return Math.abs(a.y - b.y) < 8 && b.x >= a.x + a.width
}

test('билдер без мыши: форма собирается клавиатурой, секция и ряды доезжают до респондента', async ({
  page,
  browser,
}) => {
  const uniq = Date.now()
  const formTitle = `Опрос без мыши ${uniq}`
  const nameQ = 'Ваше имя'
  const mailQ = 'Рабочая почта'
  const phoneQ = 'Телефон для связи'
  const srcQ = 'Как вы о нас узнали'
  const cityQ = 'Город'
  const nameA = `Иван ${uniq}`
  const mailA = `ivan-${uniq}@example.com`
  const srcA = 'Друзья'

  // 1. Сессия: учётка заведена мимо HTTP, вход — настоящей ручкой (куки садятся в
  // контекст, дальше и page.goto, и page.request авторизованы).
  const email = seedAccount('builder')
  await login(page, email)

  // 2. Форма — запросом к API, сразу с названием. Дальше мышь не участвует.
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf_token')!.value
  const created = await page.request.post('/api/v1/forms', {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    data: { title: formTitle },
  })
  expect(created.ok()).toBeTruthy()
  const form = (await created.json()) as { id: string; slug: string }

  await page.goto(`/forms/${form.slug}/edit`)

  // Заголовки вопросов на полотне — contenteditable с этапа 14.3 (богатый текст), а
  // не textarea; берём их по ИМЕНИ роли textbox (`aria-label` в `RichLine`) — это же
  // имя слышит скринридер, так что селектор заодно держит доступность строки.
  // Счётчик служит воротами: пока строка не появилась, печатать в неё рано.
  const canvasTitles = page.getByRole('textbox', { name: 'Заголовок вопроса' })

  // 3. Каретка — в название формы (focus, а не клик).
  await page.getByLabel('Название формы').focus()

  // 3b. ФАЗА 15: заголовок формы — ОБЫЧНАЯ СТРОКА полотна. Красим последнее слово тем
  // же Mod+B, что и подпись вопроса, и откатываем тем же Mod+Z. До фазы это поле было
  // неуправляемым специально — `Ctrl+Z` в нём принадлежал браузеру, а сам заголовок
  // ехал в БД мимо автосейва и мимо публикации. Проверить это можно только здесь:
  // юнит видит модель, но не то, чьему стеку достаётся клавиша в живом браузере.
  const titleRow = page.locator('.rf-title[data-rich-line]')
  const titleTail = formTitle.slice(formTitle.lastIndexOf(' ') + 1)
  for (let i = 0; i < titleTail.length; i++) {
    await page.keyboard.press('Shift+ArrowLeft')
  }
  await page.keyboard.press(`${MOD}+KeyB`)
  await expect(titleRow.locator('.rf-b')).toHaveText(titleTail)
  await page.keyboard.press(`${MOD}+KeyZ`)
  await expect(titleRow.locator('.rf-b')).toHaveCount(0)
  await page.keyboard.press(`${MOD}+Shift+KeyZ`)
  await expect(titleRow.locator('.rf-b')).toHaveText(titleTail)

  // Enter с заголовка уводит на полотно. Форма пустая, поэтому Enter здесь создаёт
  // первую строку (focusFirstOrCreate).
  await titleRow.focus()
  await page.keyboard.press('Enter')

  // 4. Первый вопрос: «/» остаётся в тексте литералом и открывает инлайн-меню,
  // продолжение набора фильтрует. Фильтр БЕЗ ПРОБЕЛОВ — пробел закрывает меню
  // (onLabelChange), это часть контракта §3.5, а не ограничение теста.
  //
  // Открытое меню — ещё и доказательство, что каретка ушла из названия формы на
  // строку полотна: в названии «/» меню не открывает. Ждём его, а не полагаемся на
  // то, что React успел перерисоваться между нажатиями.
  await page.keyboard.type('/Корот')
  await expect(page.getByRole('option', { name: 'Короткий ответ' }).first()).toBeVisible()
  // Enter берёт первый пункт отфильтрованного списка; порядок MENU_ITEMS (вопросы →
  // отдельные поля → лэйаут) гарантирует, что это связка «заголовок + поле», и
  // каретка встаёт на её заголовок.
  await page.keyboard.press('Enter')
  await expect(canvasTitles).toHaveCount(1)
  await page.keyboard.type(nameQ)

  // 4b. Форматирование с клавиатуры (фаза 14). Единственная автоматика, которая ходит
  // по границе «браузер ↔ наша модель»: юниты держат модель, разметку и канон спанов,
  // но не то, КАК марка нарисована, — и фаза 14 теряла жирный ровно там дважды (сперва
  // не было CSS-правила вовсе, потом оно лежало в стилях кабинета, то есть публичная
  // форма жирный не показывала).
  //
  // Выделяем последнее слово заголовка стрелками с Shift — мышь в этом сценарии не
  // участвует. Панель форматирования при этом всплывает, но её не трогаем: она
  // держится на позиционировании портала, и клик по ней через Playwright проверял бы
  // координаты, а не марку.
  const boldWord = nameQ.slice(nameQ.lastIndexOf(' ') + 1)
  for (let i = 0; i < boldWord.length; i++) {
    await page.keyboard.press('Shift+ArrowLeft')
  }
  await page.keyboard.press(`${MOD}+KeyB`)
  // На полотне жирным стало ровно выделенное, а не вся подпись: марка разрезала спан
  // по границам выделения.
  await expect(canvasTitles.nth(0).locator('.rf-b')).toHaveText(boldWord)

  // 5. Enter с заголовка кладёт новую строку ПОСЛЕ всей группы (не внутрь вопроса) —
  // на ней собираем второй вопрос тем же жестом.
  await page.keyboard.press('Enter')
  await page.keyboard.type('/Email')
  await expect(page.getByRole('option', { name: 'Email' }).first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(canvasTitles).toHaveCount(2)
  await page.keyboard.type(mailQ)

  // 6. Ряд (§5, этап 13.6): Mod+Alt+→ — клавиатурное зеркало жеста, команда переноса
  // в правую ячейку ряда предыдущего вопроса. Оба типа в whitelist `canShareRow`.
  await page.keyboard.press(`${MOD}+Alt+ArrowRight`)

  // Ряд виден на полотне: заголовки стоят на одной высоте, второй правее первого.
  // Проверяем геометрией, а не классом — у полотна своя раскладка (flex-wrap + 50%),
  // общий `.rf-row` есть только у превью и рендерера, и совпасть они обязаны видом.
  // Текст строки — в содержимом узла, а не в `value`: у contenteditable его нет.
  await expect(canvasTitles.nth(0)).toHaveText(nameQ)
  await expect(canvasTitles.nth(1)).toHaveText(mailQ)
  // poll, а не разовый замер: перенос в ряд — обычный ре-рендер React, и координаты
  // сразу после нажатия клавиши могут быть ещё старыми (столбик). Ждём, а не гадаем.
  await expect.poll(() => sideBySide(canvasTitles.nth(0), canvasTitles.nth(1))).toBe(true)

  // 6b. СЕКЦИЯ (этап 15.6): в колонке живёт стопка. Enter с заголовка левой колонки
  // кладёт новую строку ПОД всей секцией (полноширинная строка в её середине разрезала
  // бы секцию пополам — на этом полотно и разваливалось до починки), а Mod+Alt+→ на
  // третьем вопросе уводит его в ПРАВУЮ колонку, под второй.
  await page.keyboard.press('Enter')
  await page.keyboard.type('/Телефон')
  await expect(page.getByRole('option', { name: 'Телефон' }).first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(canvasTitles).toHaveCount(3)
  await page.keyboard.type(phoneQ)
  await page.keyboard.press(`${MOD}+Alt+ArrowRight`)

  // Стопка справа: телефон ПОД почтой (обе правее имени, одна колонка).
  await expect
    .poll(async () => {
      const name = await canvasTitles.nth(0).boundingBox()
      const mail = await canvasTitles.nth(1).boundingBox()
      const phone = await canvasTitles.nth(2).boundingBox()
      if (!name || !mail || !phone) return false
      return phone.y > mail.y && Math.abs(phone.x - mail.x) < 4 && phone.x >= name.x + name.width
    })
    .toBe(true)

  // 7. Четвёртый вопрос — с вариантами: Enter уводит из колонки на новую строку под
  // секцией, Mod+Enter с заголовка прыгает к полю ответа — тут это первый (пустой)
  // вариант, Enter в варианте заводит следующий.
  await page.keyboard.press('Enter')
  await page.keyboard.type('/Один')
  await expect(page.getByRole('option', { name: 'Один из списка' }).first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(canvasTitles).toHaveCount(4)
  await page.keyboard.type(srcQ)

  // Mod+Enter с заголовка — к полю ответа группы; у choice это его единственный
  // (пустой) вариант, рождённый вместе с вопросом (`newFieldBlock`). Значение
  // варианта после набора — доказательство, что прыжок попал куда обещано: уйди
  // текст в заголовок, тест упадёт здесь, а не через десять шагов на публикации.
  await page.keyboard.press(`${MOD}+Enter`)
  await page.keyboard.type(srcA)
  await expect(page.getByLabel('Вариант 1')).toHaveValue(srcA)
  await page.keyboard.press('Enter')
  await page.keyboard.type('Реклама')
  await expect(page.getByLabel('Вариант 2')).toHaveValue('Реклама')

  // 7b. РЯД ВНУТРИ ВОПРОСА (этап 15.4): та же клавиша на не первой строке группы
  // собирает ряд не с предыдущим вопросом, а СО СВОЕЙ ПОДПИСЬЮ — уровень задаёт место
  // строки в группе. Единственный вход к нему с клавиатуры — поверхность самого поля
  // (инпут плейсхолдера), поэтому сперва Mod+Enter с заголовка.
  // Выход из списка — двумя Enter: первый заводит пустой последний вариант, второй
  // (в пустом) удаляет его и открывает строку ниже (§3.2, контракт фокуса §12).
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/Корот')
  await expect(page.getByRole('option', { name: 'Короткий ответ' }).first()).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(canvasTitles).toHaveCount(5)
  await page.keyboard.type(cityQ)
  await page.keyboard.press(`${MOD}+Enter`) // к полю ответа своего вопроса
  await page.keyboard.press(`${MOD}+Alt+ArrowRight`)

  // Подпись и её поле — на одной высоте, поле правее. Геометрия, а не класс: у полотна
  // своя раскладка, общий `.rf-row` есть только у превью и рендерера. Берём СТРОКИ
  // полотна (`data-block-id` — корень BlockRow): у инпута плейсхолдера нет ни своего
  // имени, ни постоянного плейсхолдера — надпись в нём появляется только под фокусом.
  const canvasRows = page.locator('[data-block-id]')
  const rowCount = await canvasRows.count()
  await expect
    .poll(() => sideBySide(canvasRows.nth(rowCount - 2), canvasRows.nth(rowCount - 1)))
    .toBe(true)

  // 8. Публикация — тоже без мыши: кнопка активна, только когда автосейв догнал
  // редактор; фокусируем и жмём Enter.
  const publish = page.getByRole('button', { name: 'Опубликовать' })
  await expect(publish).toBeEnabled()
  await publish.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/forms\/[^/]+\/share/)

  const link = await page.locator('input[readonly]').first().inputValue()
  expect(link).toContain('/r/')

  // 9. Респондент на десктопе: ряд остался рядом, вопросы отвечаются.
  const desktop = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: RENDERER })
  const formPage = await desktop.newPage()
  await formPage.goto(link)

  // Поле находится по ПОЛНОЙ подписи — это заодно доказательство, что разметка не
  // протекла в доступное имя: оно собирается из плоского текста, а не из спанов.
  const nameField = formPage.getByLabel(nameQ)
  const mailField = formPage.getByLabel(mailQ)
  await expect(nameField).toBeVisible()

  // Жирное доехало до респондента И НАРИСОВАНО. Класс — это только модель; правило
  // `.rf-b` живёт в общем fields.css, и единственное доказательство, что оно доехало до
  // ПУБЛИЧНОЙ формы (а не осталось в стилях кабинета, как было в этапе 14.1), —
  // насыщенность, снятая с живого элемента прод-сборки.
  const boldOnForm = formPage.locator('.rf-form .rf-b').first()
  await expect(boldOnForm).toHaveText(boldWord)
  const weight = await boldOnForm.evaluate((el) => getComputedStyle(el).fontWeight)
  expect(Number(weight)).toBeGreaterThanOrEqual(600)

  // ЗАГОЛОВОК ФОРМЫ (фаза 15) публикуется вместе со схемой и несёт свою разметку —
  // раньше он ехал в БД мимо публикации и разметки не знал вовсе. А `<title>` вкладки
  // остаётся ПЛОСКИМ: его собирает сервер из `plainText`, и протеки туда спаны, в
  // выдаче поисковика оказался бы кусок HTML.
  const titleOnForm = formPage.locator('h1.rf-title')
  await expect(titleOnForm).toHaveText(formTitle)
  await expect(titleOnForm.locator('.rf-b')).toHaveText(titleTail)
  expect(await formPage.title()).toContain(formTitle)
  expect(await formPage.title()).not.toMatch(/<span|rf-b/)

  // СЕКЦИЯ (этап 15.6): обёртка ряда достаётся только ряду из двоих, и она одна на
  // поток вопросов — второй `.rf-row` в форме есть, но он ВНУТРИ вопроса «Город»
  // (уровень ниже, §13 EDITOR.md). Проверяем оба, разведя их по родителю.
  const section = formPage.locator('.rf-form > .rf-row')
  await expect(section).toHaveCount(1)
  const cells = section.locator(':scope > .rf-cell')
  await expect(cells).toHaveCount(2)
  // Слева один вопрос, справа СТОПКА из двух — то, ради чего этап и делался.
  await expect(cells.nth(0).locator('.rf-group')).toHaveCount(1)
  await expect(cells.nth(1).locator('.rf-group')).toHaveCount(2)
  await expect(section.getByText(nameQ)).toBeVisible()
  await expect(section.getByText(phoneQ)).toBeVisible()

  // Ряд ВНУТРИ вопроса (этап 15.4): подпись и поле в одной строке, обёртка — своя.
  await expect(formPage.locator('.rf-group > .rf-row')).toHaveCount(1)
  expect(await sideBySide(formPage.getByText(cityQ), formPage.getByLabel(cityQ))).toBe(true)

  expect(await sideBySide(nameField, mailField)).toBe(true)
  // Стопка справа: телефон под почтой и в той же колонке.
  const phoneField = formPage.getByLabel(phoneQ)
  const mailBox = (await mailField.boundingBox())!
  const phoneBox = (await phoneField.boundingBox())!
  expect(phoneBox.y).toBeGreaterThan(mailBox.y)
  expect(Math.abs(phoneBox.x - mailBox.x)).toBeLessThan(4)

  await nameField.fill(nameA)
  await mailField.fill(mailA)
  // Вариант выбирается кликом по КАРТОЧКЕ, а не по радиокнопке: настоящий input
  // спрятан (`.rf-choice-input` — position:absolute под карточкой), видимый контрол —
  // сама `label.rf-option`, и поверх input'а лежит буквенный бейдж «A». `.check()` по
  // роли упирается в него («intercepts pointer events») — но это не дефект: респондент
  // жмёт карточку, а не невидимый кружок. Клик по label переключает input штатно,
  // поэтому проверяем результат ролью — так падение отличит «не кликнулось» от
  // «кликнулось не туда».
  await formPage.locator('label.rf-option', { hasText: srcA }).click()
  await expect(formPage.getByRole('radio', { name: srcA })).toBeChecked()

  // Антиспам (фаза 5): отправка быстрее 3 с от выдачи формы отклоняется как бот.
  await formPage.waitForTimeout(3500)
  await formPage.locator('button.rf-submit').click()
  await expect(formPage.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()
  await desktop.close()

  // 10. Тот же ряд на телефоне — столбик (медиазапрос `.rf-row` в общем fields.css).
  // Отдельным анонимным контекстом, без отправки: предмет — раскладка.
  const mobile = await browser.newContext({
    ...devices['Pixel 5'],
    ignoreHTTPSErrors: true,
    baseURL: RENDERER,
  })
  const mobilePage = await mobile.newPage()
  await mobilePage.goto(link)
  const mobileName = (await mobilePage.getByLabel(nameQ).boundingBox())!
  const mobileMail = (await mobilePage.getByLabel(mailQ).boundingBox())!
  expect(mobileMail.y).toBeGreaterThan(mobileName.y + mobileName.height)
  // Ряд ВНУТРИ вопроса разваливается тем же правилом: подпись над своим полем.
  const mobileCity = (await mobilePage.getByText(cityQ).boundingBox())!
  const mobileCityField = (await mobilePage.getByLabel(cityQ).boundingBox())!
  expect(mobileCityField.y).toBeGreaterThan(mobileCity.y)
  await mobile.close()

  // 11. Ответ доехал до кабинета: форма, собранная клавиатурой, даёт нормальные
  // данные — вопросы ряда не потеряли ни подписи, ни значений.
  await page.goto(`/forms/${form.slug}/responses`)
  await expect(page.getByRole('heading', { name: formTitle })).toBeVisible()
  await page.getByRole('button', { name: 'Открыть' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(nameA)).toBeVisible()
  await expect(dialog.getByText(mailA)).toBeVisible()
  await expect(dialog.getByText(srcA, { exact: true })).toBeVisible()

  // 12. В данные разметка не протекает (сквозной критерий фазы 14): в сводке ответов
  // подпись вопроса — плоская строка, и в CSV колонка называется тем же текстом, без
  // единого следа спанов. Тянем выгрузку запросом, а не скачиванием: предмет — её
  // содержимое, а ход «ссылка → файл» держит full-loop.
  // Подпись вопроса в карточке ответа — плоская строка целиком, и ни одного носителя
  // марки в диалоге нет: сводка берёт `plainText`, а не спаны.
  await expect(dialog.getByText(nameQ, { exact: true })).toBeVisible()
  await expect(dialog.locator('.rf-b')).toHaveCount(0)

  await page.keyboard.press('Escape') // оверлей диалога перекрывает ссылку экспорта
  await expect(dialog).toBeHidden()

  const csvHref = await page.getByRole('link', { name: 'Экспорт CSV' }).getAttribute('href')
  const csv = await (await page.request.get(csvHref!)).text()
  expect(csv).toContain(nameQ)
  // Разметка в CSV выглядела бы либо тегом, либо сырым спаном — обе формы ловим здесь,
  // потому что обе означают одно: выгрузку открыли в Excel и увидели мусор.
  expect(csv).not.toMatch(/<span|rf-b|"m":/)
})
