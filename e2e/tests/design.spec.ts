import { test, expect, devices } from '@playwright/test'
import { login, seedAccount } from './helpers/session'

// Оформление формы (фаза 22) против prod-local: то, что автор задал в шторке, —
// глазами респондента и в сыром HTML, который отдаёт Go.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СЦЕНАРИЙ. Перевод настроек в переменные покрыт таблицами кейсов с
// обеих сторон, гейт — юнитами сервиса, оболочка — тестами public_page на ПОДДЕЛЬНОМ
// index.html. Не покрыто ровно то, что живёт на стыке и ломается молча:
//   1. оформление стоит в теге <html> ДО единой строчки JS — то есть тёмная форма
//      тёмная с первого кадра, а не после второго запроса за схемой. Проверяется
//      сырым текстом ответа, а не DOM'ом: в DOM к моменту проверки уже поработал
//      клиент, и отличить сервер от него невозможно;
//   2. preload шрифта указывает на файл, который РЕАЛЬНО собрал vite (Go сканирует
//      каталог с хешированными именами — в юните этого каталога нет);
//   3. гейт тарифа отвечает 402 через настоящий стек, а черновик с той же платной
//      настройкой перед этим сохраняется 200 — автосейв гейт не роняет;
//   4. бейдж «Сделано в Trillix» стоит на бесплатной форме и на экране «Спасибо»;
//   5. форма, у которой оформление не трогали, отдаёт прежнюю оболочку.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Свой CSS до респондента не доезжает в этом сценарии:
// учётка сидируется на бесплатном тарифе, а `form_custom_css` за пейгейтом (миграция
// 0019), и способа выдать пространству платный план мимо БД у e2e нет. Поэтому здесь
// проверяется ОТКАЗ (он и есть предмет гейта), а применение авторского правила
// остаётся на юнитах `customCss.test.ts` и ручном прогоне. Заводить ради этого
// подкоманду «выдать план» — отдельная задача, а не хвост сценария.
//
// ФОРМА СОБИРАЕТСЯ ЧЕРЕЗ API (правило проекта: через билдер кликами ходят только
// full-loop и builder-keyboard). Предмет здесь — публичный контур, а не шторка.
const RENDERER = process.env.E2E_RENDERER_URL ?? 'https://f.localhost'

const QUESTION = 'Как вас зовут'

// Цвета берутся ЗАМЕТНО тёмными и без круглых чисел: значение обязано доехать до
// атрибута дословно, а совпадение с чьим-нибудь дефолтом ничего бы не доказало.
const CANVAS = '#101418'
const ACCENT = '#7cc4a3'

test('оформление: тёмная форма с первого кадра, preload шрифта, бейдж и 402 за свой CSS', async ({
  page,
  browser,
}) => {
  const uniq = Date.now()
  const formTitle = `Оформленная ${uniq}`

  const email = seedAccount('design')
  await login(page, email)

  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf_token')!.value
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }

  const created = await page.request.post('/api/v1/forms', { headers, data: { title: formTitle } })
  expect(created.ok()).toBeTruthy()
  const form = (await created.json()) as { id: string; slug: string; updatedAt: string }

  const blocks = [
    { id: 't_name', groupId: 'g_name', type: 'title', text: [{ t: QUESTION }] },
    { id: 'name', groupId: 'g_name', type: 'short_text', settings: {} },
  ]
  const design = {
    theme: 'dark',
    palette: { canvas: CANVAS, accent: ACCENT },
    font: 'inter',
    layout: { width: 720 },
  }

  // 1. ЧЕРНОВИК СО СВОИМ CSS СОХРАНЯЕТСЯ. Гейт стоит на публикации именно затем,
  // чтобы автосейв не возвращал 402 посреди набора: 200 здесь — предмет проверки,
  // а не подготовка к ней.
  const savedWithCss = await page.request.patch(`/api/v1/forms/${form.id}`, {
    headers,
    data: {
      updatedAt: form.updatedAt,
      draftSchema: { schemaVersion: 4, design: { ...design, css: '.rf-page{padding:0}' }, blocks },
    },
  })
  expect(savedWithCss.ok()).toBeTruthy()
  const afterCss = (await savedWithCss.json()) as { updatedAt: string }

  // 2. А ПУБЛИКАЦИЯ ЕГО НЕ ПУСКАЕТ — 402 с кодом тарифа. Тело важно не меньше кода:
  // «недоступно» без причины заставляет автора гадать, что снять.
  const refused = await page.request.post(`/api/v1/forms/${form.id}/publish`, { headers })
  expect(refused.status()).toBe(402)
  const refusedBody = (await refused.json()) as { error: { code: string; message: string } }
  expect(refusedBody.error.code).toBe('plan_required')
  expect(refusedBody.error.message).toContain('CSS')

  // 3. Снимаем свой CSS — остальное оформление бесплатно (обе темы, цвета, шрифт и
  // ширина открыты всем планам), и та же публикация проходит.
  const saved = await page.request.patch(`/api/v1/forms/${form.id}`, {
    headers,
    data: { updatedAt: afterCss.updatedAt, draftSchema: { schemaVersion: 4, design, blocks } },
  })
  expect(saved.ok()).toBeTruthy()
  expect((await page.request.post(`/api/v1/forms/${form.id}/publish`, { headers })).ok()).toBeTruthy()

  // 4. СЫРОЙ HTML — доказательство первого кадра. Ответ ещё не видел браузера,
  // поэтому всё найденное здесь напечатал Go из снапшота версии.
  const shell = await page.request.get(`${RENDERER}/r/${form.slug}`)
  expect(shell.ok()).toBeTruthy()
  const html = await shell.text()
  expect(html).toContain('class="rf-theme-dark"')
  // Формат — тот, что печатает DesignStyleAttr: `имя: значение; `, имена по алфавиту.
  expect(html).toContain(`--rf-canvas: ${CANVAS}`)
  expect(html).toContain(`--rf-accent: ${ACCENT}`)
  expect(html).toContain('--rf-column: 720px')
  // Цвет строки браузера — холст формы, иначе тёмная страница получает светлую рамку
  // на мобильном.
  expect(html).toContain(`<meta name="theme-color" content="${CANVAS}">`)
  // Preload ведёт на файл, который собрал vite: имя хешировано, поэтому проверяем
  // форму ссылки, а не конкретное имя.
  expect(html).toMatch(
    /<link rel="preload" as="font" type="font\/woff2" crossorigin href="\/assets\/inter-[^"]+\.woff2">/,
  )

  // 5. Респондент: страница действительно тёмная (считает браузер, а не мы) и с
  // бейджем площадки — учётка на бесплатном тарифе.
  const guest = await browser.newContext({
    ...devices['Pixel 5'],
    ignoreHTTPSErrors: true,
    baseURL: RENDERER,
  })
  const guestPage = await guest.newPage()
  await guestPage.goto(`${RENDERER}/r/${form.slug}`)

  await expect(guestPage.getByLabel(QUESTION)).toBeVisible()
  // color-scheme приходит из класса темы: без него тёмная форма получает светлый
  // скроллбар и белое автозаполнение поверх своих цветов.
  const scheme = await guestPage.evaluate(
    () => getComputedStyle(document.documentElement).colorScheme,
  )
  expect(scheme).toBe('dark')
  // Холст красится через body — область оверскролла обязана ехать за темой.
  const canvas = await guestPage.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(canvas).toBe('rgb(16, 20, 24)')

  const badge = guestPage.locator('.rf-badge a')
  await expect(badge).toBeVisible()
  await expect(badge).toHaveAttribute('href', 'https://trillix.ru')

  // 6. Экран «Спасибо» — та же тема и тот же бейдж: иначе бренд снимается
  // разглядыванием второго экрана, а форма мигает белым после отправки.
  await guestPage.getByLabel(QUESTION).fill(`Иван ${uniq}`)
  // Антиспам (фаза 5): отправка быстрее 3 с от выдачи формы отклоняется как бот.
  await guestPage.waitForTimeout(3500)
  await guestPage.locator('button.rf-submit').click()

  await expect(guestPage.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()
  expect(await guestPage.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    'rgb(16, 20, 24)',
  )
  await expect(guestPage.locator('.rf-badge a')).toBeVisible()
  await guest.close()

  // 7. ФОРМА БЕЗ ОФОРМЛЕНИЯ — ОБОЛОЧКА ПРЕЖНЯЯ. Первый пункт Definition of Done фазы
  // и единственный, который нельзя проверить, глядя на оформленную форму: тег <html>
  // обязан остаться голым, без класса и без единой переменной.
  const plain = await page.request.post('/api/v1/forms', {
    headers,
    data: { title: `Простая ${uniq}` },
  })
  expect(plain.ok()).toBeTruthy()
  const plainForm = (await plain.json()) as { id: string; slug: string; updatedAt: string }
  const plainSaved = await page.request.patch(`/api/v1/forms/${plainForm.id}`, {
    headers,
    data: { updatedAt: plainForm.updatedAt, draftSchema: { schemaVersion: 4, blocks } },
  })
  expect(plainSaved.ok()).toBeTruthy()
  expect(
    (await page.request.post(`/api/v1/forms/${plainForm.id}/publish`, { headers })).ok(),
  ).toBeTruthy()

  const plainHtml = await (await page.request.get(`${RENDERER}/r/${plainForm.slug}`)).text()
  expect(plainHtml).toContain('<html lang="ru">')
  expect(plainHtml).not.toContain('rf-theme-dark')
  expect(plainHtml).not.toContain('--rf-')
  expect(plainHtml).not.toContain('theme-color')
})
