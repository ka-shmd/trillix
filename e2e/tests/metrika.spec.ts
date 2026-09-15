import { execFileSync } from 'node:child_process'

import { test, expect, type Page } from '@playwright/test'
import { csrfToken, login, seedAccount } from './helpers/session'

// Счётчик Яндекс Метрики автора (фаза 29 DEV-PLAN, слайсы D и E;
// design/yandex-metrika.md §1 п. 6) против prod-local.
//
// СТРАНИЦА ФОРМЫ — ЕДИНСТВЕННОЕ МЕСТО ПРОВЕРКИ CSP. В dev её нет, а заблокированный
// скрипт не бросает исключения в нашем коде: счётчик просто не заработал бы, и цели
// молча не дошли бы до автора. Поэтому tag.js подменяется заглушкой через page.route —
// ПОСЛЕ CSP: запрос, который политика режет, до перехвата не доходит, и заглушка не
// загрузится. Настоящий Яндекс при этом не получает ни одного запроса.
//
// ВСТРОЕННАЯ ФОРМА — цели отмечает счётчик СТРАНИЦЫ через загрузчик, а во фрейме
// Метрики нет вовсе. Страница-хозяин раздаётся через route на https://embed-host.test
// с разрешённой локальной сетью — почему так, см. шапку embed.spec.ts.
//
// Тариф переключается операцией владельца (BILLING.md §6) прямо в базе: денег система
// не принимает, ручки смены тарифа нет. Счётчик на бесплатном тарифе на страницу не
// уезжает — это проверяют Go-тесты отдачи.
const RENDERER = process.env.E2E_RENDERER_URL ?? 'https://f.localhost'
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'trillix-prod-local-postgres-1'

const COUNTER = '12345678'
const QUESTION = 'Ваше имя'
const TAG_JS = 'https://mc.yandex.ru/metrika/tag.js'
const HOST_PAGE = 'https://embed-host.test/'

const GOALS = [
  [Number(COUNTER), 'reachGoal', 'trillix_open'],
  [Number(COUNTER), 'reachGoal', 'trillix_start'],
  [Number(COUNTER), 'reachGoal', 'trillix_submit'],
]

// Заглушка tag.js: разбирает очередь, накопленную рендерером до загрузки, и дальше
// пишет каждый вызов `ym` в window.__ym — как настоящий счётчик разобрал бы ту же очередь.
const TAG_STUB = `(function () {
  var queued = (window.ym && window.ym.a) || [];
  window.__ym = [];
  function ym() { window.__ym.push(Array.prototype.slice.call(arguments)); }
  for (var i = 0; i < queued.length; i++) ym.apply(null, queued[i]);
  window.ym = ym;
})();`

// Счётчик сайта-хозяина: та же запись вызовов, но стоит на странице до загрузчика —
// как стоит код Метрики на настоящем сайте.
const HOST_YM = `<script>window.__ym = []; window.ym = function () { window.__ym.push(Array.prototype.slice.call(arguments)); };</script>`

const hostHtml = (head: string, body: string) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Чужой сайт</title>${head}</head>
<body style="margin:0"><h1>Страница события</h1>${body}</body></html>`

function setPlan(email: string, plan: string): void {
  // Email едет переменной psql, а не подстановкой в текст запроса.
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      PG_CONTAINER,
      'sh',
      '-c',
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v email="$1" -v plan="$2"',
      'sh',
      email,
      plan,
    ],
    {
      input:
        "UPDATE subscriptions SET plan_code = :'plan', updated_at = now() " +
        "WHERE user_id = (SELECT id FROM users WHERE email = :'email');",
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
}

async function ymCalls(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => (window as unknown as { __ym?: unknown[][] }).__ym ?? [])
}

// Опубликованная форма с одним вопросом и подключённым счётчиком на тарифе pro.
async function formWithCounter(page: Page, prefix: string) {
  const email = seedAccount(prefix)
  await login(page, email)
  const csrf = await csrfToken(page)
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }

  const created = await page.request.post('/api/v1/forms', {
    headers,
    data: { title: `Метрика ${Date.now()}` },
  })
  expect(created.ok()).toBeTruthy()
  const form = (await created.json()) as { id: string; slug: string; updatedAt: string }

  const schema = {
    schemaVersion: 1,
    blocks: [
      { id: 't_q1', groupId: 'g_q1', type: 'title', text: [{ t: QUESTION }] },
      { id: 'q1', groupId: 'g_q1', type: 'short_text', required: false, settings: {} },
    ],
  }
  const saved = await page.request.patch(`/api/v1/forms/${form.id}`, {
    headers,
    data: { draftSchema: schema, updatedAt: form.updatedAt },
  })
  expect(saved.ok()).toBeTruthy()
  expect((await page.request.post(`/api/v1/forms/${form.id}/publish`, { headers })).ok()).toBeTruthy()

  const counterURL = `/api/v1/forms/${form.id}/counters/yandex-metrika`
  const connected = await page.request.put(counterURL, { headers, data: { counter: COUNTER } })
  expect(connected.ok()).toBeTruthy()
  setPlan(email, 'pro')

  return { slug: form.slug, headers, counterURL }
}

test('счётчик автора грузится под прод-CSP и отмечает три цели', async ({ page, browser }) => {
  const { slug, headers, counterURL } = await formWithCounter(page, 'metrika')

  // CSP: хосты Метрики — только у страницы формы. Кабинет и остальные пути домена форм
  // их не получают.
  const cabinetCSP = (await page.request.get('/')).headers()['content-security-policy'] ?? ''
  expect(cabinetCSP).not.toContain('mc.yandex.ru')
  const publicCSP =
    (await page.request.get(`${RENDERER}/public/v1/forms/${slug}`)).headers()[
      'content-security-policy'
    ] ?? ''
  expect(publicCSP).not.toContain('mc.yandex.ru')

  // 1. Респондент — свой контекст (свой кеш: тело формы кешируется на минуту).
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
  const respondent = await ctx.newPage()
  await respondent.route(TAG_JS, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: TAG_STUB }),
  )

  const doc = await respondent.goto(`${RENDERER}/r/${slug}`)
  const formCSP = doc?.headers()['content-security-policy'] ?? ''
  expect(formCSP).toContain('https://mc.yandex.ru')

  await expect
    .poll(() => ymCalls(respondent))
    .toContainEqual([
      Number(COUNTER),
      'init',
      { webvisor: false, clickmap: true, trackLinks: true, accurateTrackBounce: true },
    ])
  await expect.poll(() => ymCalls(respondent)).toContainEqual(GOALS[0])

  await respondent.getByLabel(QUESTION).fill('Иван')
  await expect.poll(() => ymCalls(respondent)).toContainEqual(GOALS[1])

  await respondent.waitForTimeout(3500) // антиспам: отправка быстрее 3 с отклоняется
  await respondent.locator('button.rf-submit').click()
  await expect(respondent.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()
  await expect.poll(() => ymCalls(respondent)).toContainEqual(GOALS[2])

  // Ровно три цели, каждая одна и одним именем: без параметров цели, где могли бы
  // оказаться ответы.
  expect((await ymCalls(respondent)).filter((c) => c[1] === 'reachGoal')).toEqual(GOALS)
  await ctx.close()

  // 2. Тумблер выключен — на странице формы нет ни скрипта, ни запросов к Яндексу.
  const off = await page.request.put(counterURL, {
    headers,
    data: { counter: COUNTER, enabled: false },
  })
  expect(off.ok()).toBeTruthy()

  const offCtx = await browser.newContext({ ignoreHTTPSErrors: true })
  const offPage = await offCtx.newPage()
  const yandex: string[] = []
  offPage.on('request', (req) => {
    if (req.url().includes('yandex')) yandex.push(req.url())
  })
  await offPage.goto(`${RENDERER}/r/${slug}`)
  await expect(offPage.getByLabel(QUESTION)).toBeVisible()
  expect(await offPage.evaluate(() => 'ym' in window)).toBe(false)
  expect(yandex).toEqual([])
  await offCtx.close()
})

test('встроенная форма отмечает цели счётчиком страницы, во фрейме Метрики нет', async ({
  page,
  browser,
}) => {
  const { slug } = await formWithCounter(page, 'metrika-embed')

  const visitor = await browser.newContext({ ignoreHTTPSErrors: true })
  await visitor.grantPermissions(['local-network-access'], { origin: HOST_PAGE })
  // Любой запрос к Яндексу из контекста — и со страницы, и из фрейма — провал: на
  // хозяине счётчик-заглушка, а во фрейме своего быть не должно.
  const yandex: string[] = []
  visitor.on('request', (req) => {
    if (req.url().includes('yandex')) yandex.push(req.url())
  })

  // 1. Блок на сайте со счётчиком. Сниппет — тот, что кабинет даёт владельцу
  // (embedSnippet.test.ts): фрейм с адресом в data-trillix-src и загрузчик. Атрибута src у
  // фрейма нет вовсе: пустой `src=""` загрузчик читает как чужой фрейм и адрес не ставит.
  const block =
    `<iframe data-trillix-src="${RENDERER}/r/${slug}?embed=block" title="Форма блоком" ` +
    `width="100%" height="520" frameborder="0"></iframe>` +
    `<script async src="${RENDERER}/embed/v1.js"></script>`
  const host = await visitor.newPage()
  await host.route(HOST_PAGE, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: hostHtml(HOST_YM, block) }),
  )
  await host.goto(HOST_PAGE)

  const frame = host.frameLocator('iframe[title="Форма блоком"]')
  await expect.poll(() => ymCalls(host)).toContainEqual(GOALS[0])
  await frame.getByLabel(QUESTION).fill('Иван')
  await expect.poll(() => ymCalls(host)).toContainEqual(GOALS[1])
  await host.waitForTimeout(3500) // антиспам: отправка быстрее 3 с отклоняется
  await frame.locator('button.rf-submit').click()
  await expect(frame.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()
  await expect.poll(() => ymCalls(host)).toContainEqual(GOALS[2])

  expect(await ymCalls(host)).toEqual(GOALS)
  const formFrame = host.frames().find((f) => f.url().includes(`/r/${slug}`))
  expect(formFrame).toBeDefined()
  expect(await formFrame!.evaluate(() => 'ym' in window)).toBe(false)

  // 2. Виджет на сайте БЕЗ Метрики: цели некуда отмечать — ни ошибки, ни запроса.
  const widget =
    `<button type="button" data-trillix-open="${slug}">Оставить заявку</button>` +
    `<script async src="${RENDERER}/embed/v1.js"></script>`
  const bare = await visitor.newPage()
  const errors: string[] = []
  bare.on('pageerror', (err) => errors.push(err.message))
  await bare.route(HOST_PAGE, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: hostHtml('', widget) }),
  )
  await bare.goto(HOST_PAGE)
  await bare.getByRole('button', { name: 'Оставить заявку' }).click()
  const widgetFrame = bare.frameLocator('iframe[title="Форма"]')
  await widgetFrame.getByLabel(QUESTION).fill('Иван') // «открыл» и «начал» ушли хосту
  await bare.waitForTimeout(1000)
  expect(errors).toEqual([])

  expect(yandex).toEqual([])
  await visitor.close()
})
