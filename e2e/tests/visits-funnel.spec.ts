import { test, expect, devices } from '@playwright/test'
import { login, seedAccount } from './helpers/session'

// Визиты и воронка (фаза 8.5, шаги 6 и 6б) против prod-local.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СЦЕНАРИЙ, а не дописать в full-loop: проверяемое здесь не зависит
// от билдера, а full-loop проходит через него целиком. Смешав, мы получили бы тест,
// который краснеет от правок редактора, ничего не говоря про аналитику.
//
// ЧТО ЗДЕСЬ ЕДИНСТВЕННОЕ МЕСТО ПРОВЕРКИ: визит считает `navigator.sendBeacon`, а
// прод-контур режет запросы строгой CSP (`connect-src 'self'`) — в dev её нет вовсе.
// Заблокированный бикон не бросает исключения и ничего не пишет в консоль страницы:
// счётчик просто остался бы нулевым, и узнать об этом можно только здесь.
//
// Форма собирается через API, а не кликами по редактору: сборка формы уже покрыта
// full-loop, дублировать её медленно и хрупко.

const RENDERER = process.env.E2E_RENDERER_URL ?? 'https://f.localhost'

const QUESTION = 'Ваше имя'
const SECOND_QUESTION = 'ИНН'

test('визит считается под прод-CSP, конверсия и воронка сходятся', async ({ page, browser }) => {
  const uniq = Date.now()
  const formTitle = `Воронка ${uniq}`

  // 1. Сессия: учётка заводится мимо HTTP, вход — обычной ручкой (сессия и
  // CSRF-cookie оказываются в контексте страницы, дальше page.request ходит
  // авторизованным). Регистрация здесь не предмет проверки, а средство — и как
  // средство она стоила сюите перезапусков: ведро `registerBurst` на три сценария
  // выбиралось в ноль, и этот, идущий последним, регулярно ловил 429.
  const email = seedAccount('visits')
  await login(page, email)

  // 2. Форма с ДВУМЯ вопросами через API. Второй нужен, чтобы воронка была
  // содержательной: респондент коснётся только первого, и шаги обязаны разойтись.
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf_token')!.value
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }

  const created = await page.request.post('/api/v1/forms', {
    headers,
    data: { title: formTitle },
  })
  expect(created.ok()).toBeTruthy()
  const form = (await created.json()) as { id: string; slug: string; updatedAt: string }

  const schema = {
    schemaVersion: 1,
    blocks: [
      { id: 'q1', type: 'short_text', label: QUESTION, description: '', required: false, settings: {} },
      {
        id: 'q2',
        type: 'short_text',
        label: SECOND_QUESTION,
        description: '',
        required: false,
        settings: {},
      },
    ],
  }
  const saved = await page.request.patch(`/api/v1/forms/${form.id}`, {
    headers,
    data: { draftSchema: schema, updatedAt: form.updatedAt },
  })
  expect(saved.ok()).toBeTruthy()
  expect((await page.request.post(`/api/v1/forms/${form.id}/publish`, { headers })).ok()).toBeTruthy()

  // 3. Респондент — анонимный мобильный контекст, как в full-loop. Метка источника в
  // адресе проверяет, что рендерер её подхватывает (utm едет в мете визита).
  const mobile = await browser.newContext({
    ...devices['Pixel 5'],
    ignoreHTTPSErrors: true,
    baseURL: RENDERER,
  })
  const respondent = await mobile.newPage()
  await respondent.goto(`${RENDERER}/r/${form.slug}?utm_source=e2e`)

  const field = respondent.getByLabel(QUESTION)
  await expect(field).toBeVisible()
  await field.fill(`Иван ${uniq}`) // фокус в первом вопросе = «дошёл до q1»

  // Антиспам (фаза 5): отправка быстрее 3 с от выдачи формы отклоняется как бот.
  await respondent.waitForTimeout(3500)
  await respondent.locator('button.rf-submit').click()
  await expect(respondent.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()

  // Уводим страницу перед закрытием: pagehide гарантированно срабатывает на
  // навигации, и рендерер шлёт второй бикон — «докуда дошёл». Без него визит остался
  // бы с last_block_id = NULL и не попал бы ни в один шаг воронки.
  await respondent.goto('about:blank')
  await mobile.close()

  // 4. Строка списка форм: просмотр, ответ и конверсия. Доказательство того, что
  // sendBeacon прошёл сквозь CSP прод-контура, здесь — сама КОНВЕРСИЯ: при нуле
  // просмотров в колонке стоит прочерк, а не «0 %» (ноль просмотров и ноль
  // отправивших — разные новости, ADR §10), поэтому «100 %» не появится, пока визит
  // не доехал.
  await page.goto('/forms')
  const row = page.locator('[data-slot="form-row"]').filter({ hasText: formTitle }).first()
  await expect(row).toContainText('100 %')

  // 5. Воронка. Респондент коснулся только q1 и отправил форму, поэтому:
  //   q1 — дошёл 1, отвала НЕТ (отправивший не отвал — ядро шага 6б);
  //   q2 — до него не дошли.
  await page.goto(`/forms/${form.slug}/funnel`)
  await expect(page.getByRole('heading', { name: 'Открыли форму' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Отправили форму' })).toBeVisible()

  const firstStep = page.getByRole('listitem').filter({ hasText: QUESTION })
  await expect(firstStep).toContainText('Здесь никто не остановился.')

  // 6. Закрытая форма визитов не набирает (410) — часть контракта шага 6: ответом
  // такой визит закончиться не мог, и пускать его значило бы дать способ портить
  // владельцу конверсию.
  //
  // Номер версии берём ДО закрытия: закрытая форма схемы уже не отдаёт (GET → 410),
  // а с неверной версией ручка ответила бы не тем статусом и проверяла бы не то.
  // Токен живёт в своей ручке и от закрытия формы не зависит вовсе (ADR §10).
  const publicForm = await page.request.get(`${RENDERER}/public/v1/forms/${form.slug}`)
  const { version } = (await publicForm.json()) as { version: number }
  const { token } = (await (
    await page.request.get(`${RENDERER}/public/v1/form-token`)
  ).json()) as { token: string }

  expect(
    (await page.request.post(`/api/v1/forms/${form.id}/unpublish`, { headers })).ok(),
  ).toBeTruthy()

  const visitAfterClose = await page.request.post(
    `${RENDERER}/public/v1/forms/${form.slug}/visits`,
    {
      headers: { 'Content-Type': 'application/json' },
      data: { visit_id: '00000000-0000-7000-8000-000000000001', token, version, seq: 0 },
      failOnStatusCode: false,
    },
  )
  expect(visitAfterClose.status()).toBe(410)
})
