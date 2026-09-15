import { execFileSync } from 'node:child_process'

import { test, expect, type Page } from '@playwright/test'
import { csrfToken, login, seedAccount } from './helpers/session'

// Счётчик Яндекс Метрики автора на странице формы (фаза 29 DEV-PLAN, слайс D;
// design/yandex-metrika.md §1 п. 6) против prod-local.
//
// ЧТО ЗДЕСЬ ЕДИНСТВЕННОЕ МЕСТО ПРОВЕРКИ — CSP. В dev её нет, а заблокированный скрипт
// не бросает исключения в нашем коде: счётчик просто не заработал бы, и цели молча не
// дошли бы до автора. Поэтому tag.js подменяется заглушкой через page.route — ПОСЛЕ
// CSP: запрос, который политика режет, до перехвата не доходит, и заглушка не
// загрузится. Настоящий Яндекс при этом не получает ни одного запроса.
//
// Тариф переключается операцией владельца (BILLING.md §6) прямо в базе: денег система
// не принимает, ручки смены тарифа нет. Счётчик на бесплатном тарифе на страницу не
// уезжает — это проверяют Go-тесты отдачи.
const RENDERER = process.env.E2E_RENDERER_URL ?? 'https://f.localhost'
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'trillix-prod-local-postgres-1'

const COUNTER = '12345678'
const QUESTION = 'Ваше имя'
const TAG_JS = 'https://mc.yandex.ru/metrika/tag.js'

// Заглушка tag.js: разбирает очередь, накопленную рендерером до загрузки, и дальше
// пишет каждый вызов `ym` в window.__ym — как настоящий счётчик разобрал бы ту же очередь.
const TAG_STUB = `(function () {
  var queued = (window.ym && window.ym.a) || [];
  window.__ym = [];
  function ym() { window.__ym.push(Array.prototype.slice.call(arguments)); }
  for (var i = 0; i < queued.length; i++) ym.apply(null, queued[i]);
  window.ym = ym;
})();`

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

test('счётчик автора грузится под прод-CSP и отмечает три цели', async ({ page, browser }) => {
  const uniq = Date.now()

  const email = seedAccount('metrika')
  await login(page, email)
  const csrf = await csrfToken(page)
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }

  const created = await page.request.post('/api/v1/forms', {
    headers,
    data: { title: `Метрика ${uniq}` },
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

  // CSP: хосты Метрики — только у страницы формы. Кабинет и остальные пути домена форм
  // их не получают.
  const cabinetCSP = (await page.request.get('/')).headers()['content-security-policy'] ?? ''
  expect(cabinetCSP).not.toContain('mc.yandex.ru')
  const publicCSP =
    (await page.request.get(`${RENDERER}/public/v1/forms/${form.slug}`)).headers()[
      'content-security-policy'
    ] ?? ''
  expect(publicCSP).not.toContain('mc.yandex.ru')

  // 1. Респондент — свой контекст (свой кеш: тело формы кешируется на минуту).
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
  const respondent = await ctx.newPage()
  await respondent.route(TAG_JS, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: TAG_STUB }),
  )

  const doc = await respondent.goto(`${RENDERER}/r/${form.slug}`)
  const formCSP = doc?.headers()['content-security-policy'] ?? ''
  expect(formCSP).toContain('https://mc.yandex.ru')

  await expect
    .poll(() => ymCalls(respondent))
    .toContainEqual([
      Number(COUNTER),
      'init',
      { webvisor: false, clickmap: true, trackLinks: true, accurateTrackBounce: true },
    ])
  await expect.poll(() => ymCalls(respondent)).toContainEqual([Number(COUNTER), 'reachGoal', 'trillix_open'])

  const field = respondent.getByLabel(QUESTION)
  await field.fill(`Иван ${uniq}`)
  await expect.poll(() => ymCalls(respondent)).toContainEqual([Number(COUNTER), 'reachGoal', 'trillix_start'])

  await respondent.waitForTimeout(3500) // антиспам: отправка быстрее 3 с отклоняется
  await respondent.locator('button.rf-submit').click()
  await expect(respondent.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()
  await expect
    .poll(() => ymCalls(respondent))
    .toContainEqual([Number(COUNTER), 'reachGoal', 'trillix_submit'])

  // Ровно три цели, каждая одна и одним именем: без параметров цели, где могли бы
  // оказаться ответы.
  const goals = (await ymCalls(respondent)).filter((c) => c[1] === 'reachGoal')
  expect(goals).toEqual([
    [Number(COUNTER), 'reachGoal', 'trillix_open'],
    [Number(COUNTER), 'reachGoal', 'trillix_start'],
    [Number(COUNTER), 'reachGoal', 'trillix_submit'],
  ])
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
  await offPage.goto(`${RENDERER}/r/${form.slug}`)
  await expect(offPage.getByLabel(QUESTION)).toBeVisible()
  expect(await offPage.evaluate(() => 'ym' in window)).toBe(false)
  expect(yandex).toEqual([])
  await offCtx.close()
})
