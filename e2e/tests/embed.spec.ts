import { test, expect } from '@playwright/test'
import { login, seedAccount } from './helpers/session'

// Встроенная форма (фаза 20) против prod-local: блок на постороннем сайте и виджет.
//
// ЧТО ЗДЕСЬ ЕДИНСТВЕННОЕ МЕСТО ПРОВЕРКИ. Встраивание упирается в прод-контур, и это
// единственное его место: в dev CSP нет вовсе, поэтому ослабленный `frame-ancestors`
// и снятый `X-Frame-Options` проверяются только здесь. Заблокированный фрейм не
// бросает исключения в нашем коде — он просто остаётся пустым прямоугольником, ровно
// как раньше выглядел бы сгенерированный сниппет на чужом сайте.
//
// ПРОВЕРЯЕТСЯ ОТПРАВКА, А НЕ ФАКТ ЗАГРУЗКИ: заголовки ломаются именно на ней (форма
// внутри фрейма ходит на свой origin, и это тот же прод-контур с той же CSP).
//
// ПОСТОРОННИЙ ORIGIN БЕЗ СЕРВЕРА. Страница-хозяин раздаётся через page.route на
// https://embed-host.test — для браузера это полноценный чужой origin, и ради теста не
// приходится ни поднимать сервер, ни трогать прод-конфиг Caddy. Перехват происходит до
// DNS и TLS, поэтому несуществующий хост и отсутствие сертификата роли не играют.
//
// ХОЗЯИН ПО HTTPS И С РАЗРЕШЁННОЙ ЛОКАЛЬНОЙ СЕТЬЮ — цена того, что прод-контур живёт на
// loopback, а хозяин снаружи него. Local Network Access в Chrome режет запрос со
// страницы-хозяина в более приватное адресное пространство (`f.localhost` — loopback)
// дважды: по http — наглухо, «the request client is not a secure context», а по https —
// спросив разрешение, которое в автоматизации некому дать. Обе блокировки молчаливые:
// загрузчик просто не грузится, фрейма нет, и падает первый же поиск поля внутри него.
// Поэтому хозяин отдаётся по https (заодно это правда про настоящие сайты, куда форму
// вставляют), а разрешение выдаётся контексту заранее. На проде ни того ни другого нет:
// там `f.trillix.ru` — обычный публичный адрес, и LNA к нему не применяется.
const RENDERER = process.env.E2E_RENDERER_URL ?? 'https://f.localhost'

const HOST_PAGE = 'https://embed-host.test/'
const Q1 = 'Ваше имя'

// Страница-хозяин: ровно тот сниппет, который кабинет даёт владельцу формы.
const hostHtml = (snippet: string) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Чужой сайт</title></head>
<body style="margin:0">
  <h1>Страница события</h1>
  <div id="slot">${snippet}</div>
  <p style="height:40px">подвал</p>
</body></html>`

test('форма живёт блоком и виджетом на постороннем сайте и принимает оттуда ответ', async ({
  page,
  browser,
}) => {
  const uniq = Date.now()
  const formTitle = `Встраивание ${uniq}`

  const email = seedAccount('embed')
  await login(page, email)

  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf_token')!.value
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }

  const created = await page.request.post('/api/v1/forms', { headers, data: { title: formTitle } })
  expect(created.ok()).toBeTruthy()
  const form = (await created.json()) as { id: string; slug: string; updatedAt: string }

  const saved = await page.request.patch(`/api/v1/forms/${form.id}`, {
    headers,
    data: {
      updatedAt: form.updatedAt,
      draftSchema: {
        schemaVersion: 4,
        blocks: [
          { id: 't_q1', groupId: 'g_q1', type: 'title', text: [{ t: Q1 }] },
          { id: 'q1', groupId: 'g_q1', type: 'short_text', required: true, settings: {} },
        ],
      },
    },
  })
  expect(saved.ok()).toBeTruthy()
  expect(
    (await page.request.post(`/api/v1/forms/${form.id}/publish`, { headers })).ok(),
  ).toBeTruthy()

  // 1. Кабинет отдаёт готовый сниппет — берём его из интерфейса, а не собираем руками:
  // так тест ловит расхождение между тем, что показано владельцу, и тем, что работает.
  // Код лежит за тумблером «Получить код»: макет вставки и код делят одну область.
  await page.goto(`/forms/${form.slug}/embed`)
  await page.getByRole('button', { name: 'Получить код' }).click()
  // Код лежит в `<pre>`, а не в поле ввода: читаем текст, а не значение. `exact`
  // обязателен — иначе под подпись подходит и кнопка «Скопировать: код для вставки».
  const snippet =
    (await page.getByLabel('Код для вставки', { exact: true }).textContent()) ?? ''
  expect(snippet).toContain('/embed/v1.js')
  // Блок — двухтеговая вставка: фрейм с адресом в data-trillix-src (пустой `src`
  // обязателен, иначе браузер начнёт грузить форму мимо загрузчика) плюс загрузчик.
  expect(snippet).toContain(`data-trillix-src="${RENDERER}/r/${form.slug}?embed=block"`)

  // ── Блок на постороннем сайте ────────────────────────────────────────────────
  const visitor = await browser.newContext({ ignoreHTTPSErrors: true })
  await visitor.grantPermissions(['local-network-access'], { origin: HOST_PAGE })
  const host = await visitor.newPage()
  await host.route(HOST_PAGE, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: hostHtml(snippet) }),
  )
  await host.goto(HOST_PAGE)

  // Фрейм блока назван САМОЙ ФОРМОЙ (её название уезжает в title сниппета) — в
  // отличие от фрейма виджета ниже, который строит загрузчик и называет «Форма».
  const frame = host.frameLocator(`iframe[title="${formTitle}"]`)
  const field = frame.getByLabel(Q1)
  // Видимое поле внутри фрейма и есть доказательство, что заголовки ослаблены: при
  // прежних SAMEORIGIN/'self' здесь был бы пустой прямоугольник.
  await expect(field).toBeVisible()

  // 2. Авторесайз: фрейм перестал быть стартовой высотой и подстроился под форму.
  const frameEl = host.locator(`iframe[title="${formTitle}"]`)
  await expect
    .poll(async () => (await frameEl.boundingBox())?.height ?? 0, { timeout: 10_000 })
    .not.toBe(520)

  // 3. Отправка ИЗ ФРЕЙМА — то, ради чего сценарий существует.
  await field.fill(`Иван ${uniq}`)
  await host.waitForTimeout(3500) // антиспам: отправка быстрее 3 с отклоняется
  await frame.locator('button.rf-submit').click()
  await expect(frame.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()

  // ── Виджет ───────────────────────────────────────────────────────────────────
  // Сниппет виджета берётся ТЕМ ЖЕ ПУТЁМ, что и блочный, — переключением вида в
  // кабинете, а не правкой строки: у видов теперь разный формат вставки (у виджета
  // один тег скрипта, у блока фрейм плюс загрузчик), и подмена атрибута в чужой
  // строке проверяла бы выдумку теста, а не то, что кабинет отдаёт владельцу.
  // Экран кода остаётся открытым: настройки живут в колонке слева и переключение
  // вида его не закрывает — второй раз жать «Получить код» не нужно (да и нельзя:
  // это тумблер, и подпись у него теперь другая).
  await page.getByRole('tab', { name: 'Виджет' }).click()
  await page.getByLabel('Надпись на кнопке').fill('Оставить заявку')
  const widgetSnippet =
    (await page.getByLabel('Код для вставки', { exact: true }).textContent()) ?? ''
  expect(widgetSnippet).toContain(`data-trillix-widget="${form.slug}"`)
  expect(widgetSnippet).toContain('data-label="Оставить заявку"')
  const widgetPage = await visitor.newPage()
  await widgetPage.route(HOST_PAGE, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: hostHtml(widgetSnippet) }),
  )
  await widgetPage.goto(HOST_PAGE)

  const trigger = widgetPage.getByRole('button', { name: 'Оставить заявку' })
  await expect(trigger).toBeVisible()
  // До нажатия формы нет вовсе: фрейм создаётся в момент открытия, иначе визит
  // засчитывался бы каждому зашедшему на чужой сайт.
  await expect(widgetPage.locator('iframe[title="Форма"]')).toHaveCount(0)

  await trigger.click()
  const dialog = widgetPage.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(widgetPage.frameLocator('iframe[title="Форма"]').getByLabel(Q1)).toBeVisible()

  // Esc — первое, что пробует человек, у которого форма открылась не вовремя.
  await widgetPage.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await visitor.close()

  // 4. Ответ из фрейма виден в кабинете и ничем не отличается от пришедшего по ссылке.
  await page.goto(`/forms/${form.slug}/responses`)
  await page.getByRole('button', { name: 'Открыть' }).first().click()
  await expect(page.getByRole('dialog').getByText(`Иван ${uniq}`)).toBeVisible()
})

test('кабинет остаётся незафреймливаемым', async ({ page }) => {
  // Регресс на ослабление фазы 20: оно сделано ТОЧЕЧНО для /r/*, и протечь на
  // кабинет не должно — там живёт cookie сессии, и фрейм на чужой странице означал
  // бы клик-джекинг по живому аккаунту.
  const app = await page.request.get('/', { failOnStatusCode: false })
  expect(app.headers()['x-frame-options']).toBe('DENY')
  expect(app.headers()['content-security-policy']).toContain("frame-ancestors 'none'")

  // А страница формы, наоборот, обязана быть встраиваемой откуда угодно и без
  // X-Frame-Options: у него нет значения «разрешить всем».
  const renderer = await page.request.get(`${RENDERER}/r/does-not-exist`, {
    failOnStatusCode: false,
  })
  expect(renderer.headers()['x-frame-options']).toBeUndefined()
  expect(renderer.headers()['content-security-policy']).toContain('frame-ancestors *')
})
