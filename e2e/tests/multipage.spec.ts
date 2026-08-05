import { test, expect, devices } from '@playwright/test'
import { login, seedAccount } from './helpers/session'

// Многостраничная форма (фаза 19) против prod-local: шаги, пошаговая валидация,
// сохранность ответов при возврате и уточнённая воронка.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СЦЕНАРИЙ. Многостраничность — единственная работа фазы, которая
// целиком живёт на границе «браузер ↔ наш код»: история переходов, фокус после смены
// шага, бикон визита под прод-CSP. Юниты этой границы не видят (STATUS §«Хвосты»), а
// дописывать её в full-loop значило бы красить сборкой формы кликами тест, который про
// страницы ничего не проверяет.
//
// ФОРМА СОБИРАЕТСЯ ЧЕРЕЗ API: полотно проверяют vitest и ручной прогон, здесь предмет —
// то, что видит РЕСПОНДЕНТ в прод-сборке.
//
// ЧТО ПРОВЕРЯЕТСЯ ВПЕРВЫЕ (и чего нет ни в одном юните):
//   1. «Далее» не пускает с незаполненным обязательным ЭТОЙ страницы и молчит про
//      поля следующих — головной критерий приёмки фазы;
//   2. хром страницы (заголовок формы) виден только на первой — решение владельца
//      2026-08-05, у которого нет другого сторожа в рендерере;
//   3. «Назад» возвращает ответы нетронутыми;
//   4. воронка ставит ушедшего на первый вопрос ДОСТИГНУТОЙ страницы, а не на поле,
//      которого он коснулся руками, — то самое уточнение, ради которого фаза трогала
//      аналитику.
const RENDERER = process.env.E2E_RENDERER_URL ?? 'https://f.localhost'

const Q1 = 'Ваше имя'
const Q2 = 'Ваша почта'
const Q3 = 'Комментарий'

test('форма из трёх страниц: шаги, пошаговая валидация, возврат и воронка', async ({
  page,
  browser,
}) => {
  const uniq = Date.now()
  const formTitle = `Анкета ${uniq}`

  const email = seedAccount('multipage')
  await login(page, email)

  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf_token')!.value
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }

  const created = await page.request.post('/api/v1/forms', { headers, data: { title: formTitle } })
  expect(created.ok()).toBeTruthy()
  const form = (await created.json()) as { id: string; slug: string; updatedAt: string }

  // Три страницы: обязательный вопрос — на первой, чтобы «Далее» было что не пустить.
  // Разрыв — обычный блок в потоке, страницы выводит раскладчик (splitPages).
  const q = (id: string, caption: string, type: string, required: boolean) => [
    { id: `t_${id}`, groupId: `g_${id}`, type: 'title', text: [{ t: caption }] },
    { id, groupId: `g_${id}`, type, required, settings: {} },
  ]
  const saved = await page.request.patch(`/api/v1/forms/${form.id}`, {
    headers,
    data: {
      updatedAt: form.updatedAt,
      draftSchema: {
        schemaVersion: 4,
        blocks: [
          ...q('q1', Q1, 'short_text', true),
          { id: 'brk1', groupId: 'g_brk1', type: 'page_break' },
          ...q('q2', Q2, 'email', false),
          { id: 'brk2', groupId: 'g_brk2', type: 'page_break' },
          ...q('q3', Q3, 'long_text', false),
        ],
      },
    },
  })
  expect(saved.ok()).toBeTruthy()
  expect((await page.request.post(`/api/v1/forms/${form.id}/publish`, { headers })).ok()).toBeTruthy()

  // ── Респондент, который дойдёт до второй страницы и уйдёт ──────────────────────
  // Отдельный контекст и отдельный визит: он проверяет воронку, и смешивать его с
  // отправившим нельзя — отправивший не отвал.
  const leaver = await browser.newContext({
    ...devices['Pixel 5'],
    ignoreHTTPSErrors: true,
    baseURL: RENDERER,
  })
  const leaverPage = await leaver.newPage()
  await leaverPage.goto(`${RENDERER}/r/${form.slug}`)
  await leaverPage.getByLabel(Q1).fill('Пётр')
  await leaverPage.locator('button.rf-next').click()
  await expect(leaverPage.getByText('Шаг 2 из 3')).toBeVisible()
  // Уводим страницу: pagehide гарантированно шлёт последний бикон визита.
  await leaverPage.goto('about:blank')
  await leaver.close()

  // ── Респондент, который заполнит форму целиком ────────────────────────────────
  const mobile = await browser.newContext({
    ...devices['Pixel 5'],
    ignoreHTTPSErrors: true,
    baseURL: RENDERER,
  })
  const respondent = await mobile.newPage()
  await respondent.goto(`${RENDERER}/r/${form.slug}`)

  // 1. Первая страница: заголовок формы и первый вопрос; вопросов следующих страниц
  // нет в DOM вовсе, и кнопки отправки тоже нет.
  await expect(respondent.getByRole('heading', { name: formTitle })).toBeVisible()
  await expect(respondent.getByText('Шаг 1 из 3')).toBeVisible()
  await expect(respondent.getByLabel(Q1)).toBeVisible()
  await expect(respondent.getByLabel(Q2)).toHaveCount(0)
  await expect(respondent.locator('button.rf-submit:not(.rf-next)')).toHaveCount(0)

  // 2. «Далее» не пускает с пустым обязательным ЭТОЙ страницы — и не жалуется на поля
  // следующих (их валидация не запускалась).
  await respondent.locator('button.rf-next').click()
  await expect(respondent.getByText('Шаг 1 из 3')).toBeVisible()
  await expect(respondent.getByText('Обязательное поле')).toHaveCount(1)

  await respondent.getByLabel(Q1).fill(`Иван ${uniq}`)
  await respondent.locator('button.rf-next').click()

  // 3. Вторая страница: хром остался на первой (заголовка формы больше нет), вопрос
  // сменился, появилась кнопка «Назад».
  await expect(respondent.getByText('Шаг 2 из 3')).toBeVisible()
  await expect(respondent.getByRole('heading', { name: formTitle })).toHaveCount(0)
  await expect(respondent.getByLabel(Q2)).toBeVisible()
  await expect(respondent.getByRole('button', { name: 'Назад' })).toBeVisible()

  await respondent.getByLabel(Q2).fill(`ivan${uniq}@example.com`)

  // 4. «Назад» и вперёд: ответы обеих страниц целы.
  await respondent.getByRole('button', { name: 'Назад' }).click()
  await expect(respondent.getByLabel(Q1)).toHaveValue(`Иван ${uniq}`)
  await respondent.locator('button.rf-next').click()
  await expect(respondent.getByLabel(Q2)).toHaveValue(`ivan${uniq}@example.com`)

  // 4б. Линии шагов: клик по пройденной возвращает на неё, непройденная кнопкой не
  // является вовсе (вперёд ведёт только «Далее» с проверкой).
  await respondent.getByRole('button', { name: 'Вернуться к шагу 1 из 3' }).click()
  await expect(respondent.getByText('Шаг 1 из 3')).toBeVisible()
  await expect(respondent.getByLabel(Q1)).toHaveValue(`Иван ${uniq}`)
  await expect(respondent.locator('button.rf-step-mark')).toHaveCount(0)
  await respondent.locator('button.rf-next').click()

  // 5. Системная кнопка «Назад» ведёт по шагам формы, а не со страницы: это ровно та
  // правка (pushState/popstate), которую не видит ни один юнит.
  await respondent.goBack()
  await expect(respondent.getByText('Шаг 1 из 3')).toBeVisible()
  await expect(respondent.getByLabel(Q1)).toHaveValue(`Иван ${uniq}`)
  await respondent.locator('button.rf-next').click()

  // 6. Третья страница — последняя: «Далее» нет, есть отправка.
  await respondent.locator('button.rf-next').click()
  await expect(respondent.getByText('Шаг 3 из 3')).toBeVisible()
  await expect(respondent.locator('button.rf-next')).toHaveCount(0)
  await respondent.getByLabel(Q3).fill('Всё понравилось')

  // Антиспам (фаза 5): отправка быстрее 3 с от выдачи формы отклоняется как бот.
  await respondent.waitForTimeout(3500)
  await respondent.locator('button.rf-submit').click()
  await expect(respondent.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()
  await respondent.goto('about:blank')
  await mobile.close()

  // 7. Кабинет: ответ собран со ВСЕХ страниц одним ответом — многостраничность не
  // изменила ни приём, ни таблицу.
  await page.goto(`/forms/${form.slug}/responses`)
  await expect(page.getByRole('button', { name: 'Открыть' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Открыть' }).click()
  await expect(page.getByText(`Иван ${uniq}`)).toBeVisible()
  await expect(page.getByText(`ivan${uniq}@example.com`)).toBeVisible()
  await expect(page.getByText('Всё понравилось')).toBeVisible()

  // 8. Воронка: ушедший со второй страницы стоит на ЕЁ первом вопросе, хотя руками он
  // касался только первого. Это и есть обещанное ADR §10 уточнение — «переход на
  // страницу» вместо «касания поля», и проверить его можно только здесь: бикон
  // подчиняется прод-CSP, а в dev её нет вовсе.
  await page.goto(`/forms/${form.slug}/funnel`)
  const secondStep = page.getByRole('listitem').filter({ hasText: Q2 })
  await expect(secondStep).toContainText('1')
  const firstStep = page.getByRole('listitem').filter({ hasText: Q1 })
  await expect(firstStep).toContainText('Здесь никто не остановился.')
})
