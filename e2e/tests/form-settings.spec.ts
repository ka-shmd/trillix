import { test, expect, devices } from '@playwright/test'
import { csrfToken, login, seedAccount } from './helpers/session'

// Настройки формы на стороне респондента (фаза 8.5, шаги 1 и 4) против prod-local:
// свой текст благодарности и лимит мест, закрывающий приём.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СЦЕНАРИЙ, а не дописать в full-loop: тому нужен ВТОРОЙ респондент
// (первый занимает единственное место, второй упирается в закрытую форму), то есть
// ещё один браузерный контекст и ещё одна отправка. Пришив это к сборке формы
// кликами по редактору, мы получили бы длинный тест, который краснеет от правок
// билдера, ничего не говоря про настройки. Та же причина, по которой отдельным
// сделан visits-funnel.
//
// ФОРМА СОБИРАЕТСЯ ЧЕРЕЗ API, а не кликами: билдер и страницу настроек проверяют
// vitest и ручной прогон, а здесь проверяется то, что видит РЕСПОНДЕНТ в прод-сборке.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ ВПЕРВЫЕ:
//   1. thankYouText едет в схеме → снапшот версии при публикации → экран рендерера.
//      Юнит thankYouPlan.test.ts держит выбор текста, но не то, что текст доехал.
//   2. Лимит закрывает форму САМ, без правки status: «фактически закрыта» считается
//      на чтении (ADR §10). visits-funnel трогает 410 у снятой вручную формы и только
//      как код ответа ручки визитов — экран «приём закрыт» не рисует никто.
const RENDERER = process.env.E2E_RENDERER_URL ?? 'https://f.localhost'

const QUESTION = 'Ваше имя'

test('свой текст благодарности и лимит мест: второй респондент видит «приём закрыт»', async ({
  page,
  browser,
}) => {
  const uniq = Date.now()
  const formTitle = `Регистрация ${uniq}`
  const thankYouText = `Записали вас, до встречи ${uniq}`
  const closedMessage = `Мест больше нет ${uniq}`

  // 1. Сессия: учётка заводится мимо HTTP, вход — обычной ручкой (сессия и
  // CSRF-cookie оказываются в контексте страницы, дальше page.request ходит
  // авторизованным). Регистрация здесь не предмет проверки, а средство: ведро
  // `registerBurst` бережём для full-loop, которому она предмет.
  const email = seedAccount('settings')
  await login(page, email)

  const csrf = await csrfToken(page)
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }

  const created = await page.request.post('/api/v1/forms', { headers, data: { title: formTitle } })
  expect(created.ok()).toBeTruthy()
  const form = (await created.json()) as { id: string; slug: string; updatedAt: string }

  // 2. Схема с текстом благодарности. thankYouText — поле уровня формы рядом с
  // submitLabel (плоское, не вложенный afterSubmit), живёт в документе, поэтому
  // попадает к респонденту только через публикацию — снапшот версии.
  const saved = await page.request.patch(`/api/v1/forms/${form.id}`, {
    headers,
    data: {
      updatedAt: form.updatedAt,
      draftSchema: {
        schemaVersion: 1,
        thankYouText,
        blocks: [
          {
            id: 'q1',
            type: 'short_text',
            label: QUESTION,
            description: '',
            required: false,
            settings: {},
          },
        ],
      },
    },
  })
  expect(saved.ok()).toBeTruthy()
  expect((await page.request.post(`/api/v1/forms/${form.id}/publish`, { headers })).ok()).toBeTruthy()

  // 3. Лимит в одно место и свой текст закрытия. Это ЖИВЫЕ настройки (колонки forms,
  // не схема), поэтому применяются без повторной публикации — здесь это и проверяется:
  // патч идёт ПОСЛЕ публикации, и он обязан подействовать.
  const limited = await page.request.patch(`/api/v1/forms/${form.id}`, {
    headers,
    data: { closeSettings: { closeAt: null, responseLimit: 1, closedMessage } },
  })
  expect(limited.ok()).toBeTruthy()

  // 4. Первый респондент — анонимный мобильный контекст, как в остальных сценариях.
  const first = await browser.newContext({
    ...devices['Pixel 5'],
    ignoreHTTPSErrors: true,
    baseURL: RENDERER,
  })
  const firstPage = await first.newPage()
  await firstPage.goto(`${RENDERER}/r/${form.slug}`)

  const field = firstPage.getByLabel(QUESTION)
  await expect(field).toBeVisible()
  await field.fill(`Иван ${uniq}`)

  // Антиспам (фаза 5): отправка быстрее 3 с от выдачи формы отклоняется как бот.
  await firstPage.waitForTimeout(3500)
  await firstPage.locator('button.rf-submit').click()

  // Заголовок экрана остаётся стандартным «Спасибо!» — свой текст владельца идёт
  // деталью под ним (ThankYou.tsx), а не подменяет заголовок. Проверяем именно текст:
  // заголовок был бы виден и с пустой настройкой, то есть ничего бы не доказывал.
  await expect(firstPage.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()
  await expect(firstPage.getByText(thankYouText)).toBeVisible()
  await first.close()

  // 5. Второй респондент — свежий контекст (место уже занято). Форма НЕ снята с
  // публикации: её закрыл достигнутый лимит, вычисляемый на чтении.
  const second = await browser.newContext({
    ...devices['Pixel 5'],
    ignoreHTTPSErrors: true,
    baseURL: RENDERER,
  })
  const secondPage = await second.newPage()
  await secondPage.goto(`${RENDERER}/r/${form.slug}`)

  // Экран «приём закрыт»: название формы заголовком и текст владельца деталью —
  // не безликое «форма недоступна» и не 404 (инвариант 5 сузился до черновика:
  // форма была публичной, её существование уже не секрет).
  await expect(secondPage.getByRole('heading', { name: formTitle })).toBeVisible()
  await expect(secondPage.getByText(closedMessage)).toBeVisible()
  // Вопросов и кнопки отправки на закрытой форме нет вовсе.
  await expect(secondPage.locator('button.rf-submit')).toHaveCount(0)
  await second.close()

  // 6. Кабинет видит ровно один ответ — лимит не потерял данные и не пустил лишнего.
  await page.goto(`/forms/${form.slug}/responses`)
  await expect(page.getByRole('heading', { name: formTitle })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Открыть' })).toHaveCount(1)
})
