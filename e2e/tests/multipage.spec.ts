import { test, expect, devices } from '@playwright/test'
import { login, seedAccount } from './helpers/session'

// Многостраничная форма (фаза 19) против prod-local: шаги, пошаговая валидация,
// отсутствие хода назад и уточнённая воронка.
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
//   3. при ВЫКЛЮЧЕННОЙ настройке «Возврат на прошлые страницы» (дефолт колонки 0055)
//      хода назад нет ни одного: ни экранной кнопки, ни клика по линии шага, ни записи
//      в истории — системная «Назад» уводит со страницы;
//   4. при ВКЛЮЧЁННОЙ появляются ровно два пути — кнопка и клик по пройденной линии, —
//      а третий, история браузера, не появляется и тогда (решение владельца 2026-09-07);
//   5. воронка ставит ушедшего на первый вопрос ДОСТИГНУТОЙ страницы, а не на поле,
//      которого он коснулся руками, — то самое уточнение, ради которого фаза трогала
//      аналитику.
const RENDERER = process.env.E2E_RENDERER_URL ?? 'https://f.localhost'

const Q1 = 'Ваше имя'
const Q2 = 'Ваша почта'
const Q3 = 'Комментарий'

test('форма из трёх страниц: шаги, пошаговая валидация, ход назад за настройкой, воронка', async ({
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
  // Бикон «дошёл до второй страницы» уходит из ЭФФЕКТА, то есть кадром позже отрисовки
  // линий шага. Ждать надо сам бикон, а не вид: уведя страницу сразу после появления
  // «Шаг 2 из 3», тест обгонял эффект, и в воронке этот визит вставал на первый вопрос —
  // расхождение теста с продуктом, которое выглядело как баг воронки.
  const reachedPageTwo = leaverPage.waitForRequest(
    (r) => r.url().includes('/visits') && r.method() === 'POST',
  )
  await leaverPage.locator('button.rf-next').click()
  await expect(leaverPage.locator('.rf-steps[aria-label="Шаг 2 из 3"]')).toBeVisible()
  await reachedPageTwo
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
  await expect(respondent.locator('.rf-steps[aria-label="Шаг 1 из 3"]')).toBeVisible()
  await expect(respondent.getByLabel(Q1)).toBeVisible()
  await expect(respondent.getByLabel(Q2)).toHaveCount(0)
  // Видимой подписи «Шаг N из M» нет (решение владельца): счёт несут линии, а текст
  // остаётся только скринридеру. `toBeHidden` тут не годится: приём sr-only оставляет
  // элемент в потоке размером в пиксель, и для Playwright он ВИДИМ (непустой бокс) —
  // проверять надо ровно то, чем приём является: единственное вхождение текста, и оно
  // схлопнуто в пиксель прод-стилями (не доехавший до сборки `.rf-sr-only` дал бы
  // респонденту настоящую подпись под линиями).
  const stepLabel = respondent.getByText('Шаг 1 из 3')
  await expect(stepLabel).toHaveCount(1)
  await expect(stepLabel).toHaveClass(/\brf-sr-only\b/)
  expect(await stepLabel.boundingBox()).toMatchObject({ width: 1, height: 1 })
  await expect(respondent.locator('button.rf-submit:not(.rf-next)')).toHaveCount(0)

  // 2. «Далее» не пускает с пустым обязательным ЭТОЙ страницы — и не жалуется на поля
  // следующих (их валидация не запускалась).
  await respondent.locator('button.rf-next').click()
  await expect(respondent.locator('.rf-steps[aria-label="Шаг 1 из 3"]')).toBeVisible()
  await expect(respondent.getByText('Обязательное поле')).toHaveCount(1)

  await respondent.getByLabel(Q1).fill(`Иван ${uniq}`)
  await respondent.locator('button.rf-next').click()

  // 3. Вторая страница: хром остался на первой (заголовка формы больше нет), вопрос
  // сменился, а кнопки «Назад» нет — настройка возврата у формы выключена.
  await expect(respondent.locator('.rf-steps[aria-label="Шаг 2 из 3"]')).toBeVisible()
  await expect(respondent.getByRole('heading', { name: formTitle })).toHaveCount(0)
  await expect(respondent.getByLabel(Q2)).toBeVisible()
  await expect(respondent.getByRole('button', { name: 'Назад' })).toHaveCount(0)

  await respondent.getByLabel(Q2).fill(`ivan${uniq}@example.com`)

  // 4. Линии шагов при выключенной настройке — счётчик, а не управление: пройденный
  // шаг кнопкой НЕ становится.
  await expect(respondent.locator('button.rf-step-mark')).toHaveCount(0)
  await expect(respondent.getByRole('button', { name: /Вернуться к шагу/ })).toHaveCount(0)

  // 5. Истории шагов нет: «Далее» не пишет запись через pushState, поэтому системной
  // «Назад» некуда вести внутри формы — она уводит со страницы. Проверяем здесь именно
  // отсутствие записи, а сам уход — в конце сценария: уйти посреди него значило бы
  // потерять ответы, которые он дальше и проверяет.
  expect(await respondent.evaluate(() => window.history.state)).toBeNull()

  // 6. Третья страница — последняя: «Далее» нет, есть отправка.
  await respondent.locator('button.rf-next').click()
  await expect(respondent.locator('.rf-steps[aria-label="Шаг 3 из 3"]')).toBeVisible()
  await expect(respondent.locator('button.rf-next')).toHaveCount(0)
  await respondent.getByLabel(Q3).fill('Всё понравилось')

  // Антиспам (фаза 5): отправка быстрее 3 с от выдачи формы отклоняется как бот.
  await respondent.waitForTimeout(3500)
  await respondent.locator('button.rf-submit').click()
  await expect(respondent.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()

  // 6б. Вторая половина проверки истории: системная «Назад» уводит СО СТРАНИЦЫ. Записей
  // от формы в истории нет, поэтому шаг назад отдаёт странице, с которой сюда пришли.
  await respondent.goBack()
  await expect(respondent.getByRole('heading', { name: 'Спасибо!' })).toHaveCount(0)
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

  // 9. Настройка «Возврат на прошлые страницы» (0055) — та же форма, тот же
  // опубликованный документ. Колонка живая: PATCH без перепубликации, и следующий
  // респондент получает форму с ходом назад.
  //
  // Проверяется здесь, а не своим сценарием, по правилу набора: вход под rate-limit'ом
  // (STATUS §«Хвосты»), и новая проверка живёт там, где сессия уже есть. Респондент при
  // этом свежий — настройка приезжает в теле формы, и старая вкладка её не увидит.
  const behaviorPatched = await page.request.patch(`/api/v1/forms/${form.id}`, {
    headers,
    data: { behavior: { autoJump: false, saveLocally: false, allowBack: true } },
  })
  expect(behaviorPatched.ok()).toBeTruthy()

  const backCtx = await browser.newContext({
    ...devices['Pixel 5'],
    ignoreHTTPSErrors: true,
    baseURL: RENDERER,
  })
  const backPage = await backCtx.newPage()
  await backPage.goto(`${RENDERER}/r/${form.slug}`)

  // На первой странице идти назад некуда — кнопки нет и с включённой настройкой.
  await expect(backPage.getByRole('button', { name: 'Назад' })).toHaveCount(0)
  await backPage.getByLabel(Q1).fill(`Ольга ${uniq}`)
  await backPage.locator('button.rf-next').click()
  await expect(backPage.locator('.rf-steps[aria-label="Шаг 2 из 3"]')).toBeVisible()

  // Путь первый — кнопка. Возврат ничего не теряет: набранное на первой странице
  // остаётся в поле, а не начинается заново.
  await backPage.getByRole('button', { name: 'Назад' }).click()
  await expect(backPage.locator('.rf-steps[aria-label="Шаг 1 из 3"]')).toBeVisible()
  await expect(backPage.getByLabel(Q1)).toHaveValue(`Ольга ${uniq}`)

  // Путь второй — линия пройденного шага. Кнопками становятся ТОЛЬКО те, что позади:
  // на третьей странице их две, на первой — ни одной (иначе вперёд можно было бы уйти
  // мимо «Далее», то есть мимо проверки страницы).
  await expect(backPage.locator('button.rf-step-mark')).toHaveCount(0)
  await backPage.locator('button.rf-next').click()
  await backPage.locator('button.rf-next').click()
  await expect(backPage.locator('.rf-steps[aria-label="Шаг 3 из 3"]')).toBeVisible()
  await expect(backPage.locator('button.rf-step-mark')).toHaveCount(2)
  await backPage.getByRole('button', { name: 'Вернуться к шагу 1 из 3' }).click()
  await expect(backPage.locator('.rf-steps[aria-label="Шаг 1 из 3"]')).toBeVisible()

  // Третьего пути нет и при включённой настройке: истории шагов форма не пишет ни при
  // каком её значении (решение владельца 2026-09-07) — во фрейме вставки записи ушли бы
  // в общую историю и увели бы «Назад» хост-страницы листать наши шаги.
  expect(await backPage.evaluate(() => window.history.state)).toBeNull()
  await backPage.goto('about:blank')
  await backCtx.close()
})
