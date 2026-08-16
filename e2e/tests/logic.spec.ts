import { test, expect, devices } from '@playwright/test'
import { login, seedAccount } from './helpers/session'

// Условная логика (фаза 21) против prod-local: ветвление глазами респондента и то, что
// после него остаётся в данных.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СЦЕНАРИЙ. Движок покрыт таблицами кейсов с обеих сторон, приём —
// интеграционными тестами, интерфейс — vitest и ручным прогоном. Не покрыто ровно одно:
// что в ПРОД-СБОРКЕ ветка действительно не рисуется, скрытый вариант не приходит в
// список, а перескок страницы доводит человека до кнопки отправки. Дописывать это в
// full-loop нельзя — он про сборку формы кликами и краснел бы от любой правки полотна.
//
// ФОРМА СОБИРАЕТСЯ ЧЕРЕЗ API (правило проекта: через билдер кликами ходят только
// full-loop и builder-keyboard). Предмет здесь — рендерер, приём и сводка.
//
// ЧТО ПРОВЕРЯЕТСЯ ВПЕРВЫЕ (и чего нет ни в одном юните):
//   1. скрытый вопрос отсутствует в DOM, а не спрятан стилями;
//   2. условно обязательный получает звёздочку и держит отправку ровно тогда, когда
//      условие сработало;
//   3. скрытый вариант не приходит в список и не попадает в сохранённый ответ;
//   4. переход «к отправке» убирает «Далее» и заканчивает форму на текущем шаге;
//   5. ответ на скрытый вопрос, присланный ВРУЧНУЮ, сервер принимает, но не сохраняет;
//   6. знаменатель сводки — «вопрос показали», а не число ответов формы.
const RENDERER = process.env.E2E_RENDERER_URL ?? 'https://f.localhost'

const PET = 'Есть питомец?'
const KIND = 'Какой питомец?'
const STUFF = 'Что уже купили'
const PHONE = 'Телефон для связи'

test('ветвление: скрытый вопрос, скрытый вариант, перескок страницы и честная сводка', async ({
  page,
  browser,
}) => {
  const uniq = Date.now()
  const formTitle = `Питомцы ${uniq}`

  const email = seedAccount('logic')
  await login(page, email)

  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf_token')!.value
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }

  const created = await page.request.post('/api/v1/forms', { headers, data: { title: formTitle } })
  expect(created.ok()).toBeTruthy()
  const form = (await created.json()) as { id: string; slug: string; updatedAt: string }

  // Правило «питомец = да» одно и то же у трёх носителей: видимости вопроса, его
  // обязательности и видимости варианта. Так и задумано — одно дерево на все правила.
  const ifYes = { all: [{ blockId: 'pet', op: 'is', value: 'yes' }] }

  const saved = await page.request.patch(`/api/v1/forms/${form.id}`, {
    headers,
    data: {
      updatedAt: form.updatedAt,
      draftSchema: {
        schemaVersion: 1,
        blocks: [
          // Страница 1: источник, вопрос за условием и список со скрытым вариантом.
          { id: 't_pet', groupId: 'g_pet', type: 'title', text: [{ t: PET }] },
          {
            id: 'pet',
            groupId: 'g_pet',
            type: 'single_choice',
            settings: {
              options: [
                { id: 'yes', label: 'Да' },
                { id: 'no', label: 'Нет' },
              ],
            },
          },
          // Правило стоит между источником и целями — так его проще читать, хотя
          // обходу важно лишь то, что источник выше ЦЕЛИ.
          {
            id: 'L1',
            groupId: 'g_L1',
            type: 'logic',
            logic: {
              when: ifYes,
              then: [
                { kind: 'show', target: 't_kind' },
                { kind: 'require', target: 'kind' },
                { kind: 'show_options', target: 'stuff', options: ['leash'] },
              ],
            },
          },
          { id: 't_kind', groupId: 'g_kind', type: 'title', text: [{ t: KIND }] },
          { id: 'kind', groupId: 'g_kind', type: 'short_text', settings: {} },
          { id: 't_stuff', groupId: 'g_stuff', type: 'title', text: [{ t: STUFF }] },
          {
            id: 'stuff',
            groupId: 'g_stuff',
            type: 'multi_choice',
            settings: {
              options: [
                { id: 'leash', label: 'Поводок' },
                { id: 'nothing', label: 'Ничего' },
              ],
            },
          },
          // Переход: «нет питомца» — спрашивать больше нечего. Правило принадлежит
          // странице, с которой уходят, поэтому стоит ДО разрыва.
          {
            id: 'L2',
            groupId: 'g_L2',
            type: 'logic',
            logic: {
              when: { all: [{ blockId: 'pet', op: 'is', value: 'no' }] },
              then: [{ kind: 'jump', end: true }],
            },
          },
          { id: 'brk', groupId: 'g_brk', type: 'page_break' },
          // Страница 2: её видит только ветка «да».
          { id: 't_phone', groupId: 'g_phone', type: 'title', text: [{ t: PHONE }] },
          { id: 'phone', groupId: 'g_phone', type: 'phone', settings: {} },
        ],
      },
    },
  })
  expect(saved.ok()).toBeTruthy()
  expect((await page.request.post(`/api/v1/forms/${form.id}/publish`, { headers })).ok()).toBeTruthy()

  const openForm = async () => {
    const ctx = await browser.newContext({
      ...devices['Pixel 5'],
      ignoreHTTPSErrors: true,
      baseURL: RENDERER,
    })
    const p = await ctx.newPage()
    await p.goto(`${RENDERER}/r/${form.slug}`)
    return { ctx, p }
  }

  // ── Ветка «нет питомца»: короткий путь ────────────────────────────────────────
  {
    const { ctx, p } = await openForm()

    // До ответа условие не выполнено: вопроса за ним нет В DOM (не спрятан стилями —
    // именно отсутствует), скрытого варианта в списке тоже нет.
    await expect(p.getByText(KIND)).toHaveCount(0)
    await expect(p.getByRole('checkbox', { name: 'Поводок' })).toHaveCount(0)
    await expect(p.getByRole('checkbox', { name: 'Ничего' })).toBeVisible()
    // Две страницы, пока переход не сработал: «Далее» на месте.
    await expect(p.locator('button.rf-next')).toBeVisible()

    // Вариант выбирается кликом по КАРТОЧКЕ: настоящий input спрятан под ней, а поверх
    // лежит буквенный бейдж — `.check()` по роли упирается в него. Тот же приём и та же
    // причина, что в builder-keyboard.
    await p.locator('label.rf-option', { hasText: 'Нет' }).click()
    await expect(p.getByRole('radio', { name: 'Нет' })).toBeChecked()

    // Переход «к отправке» сработал: путь стал одностраничным — «Далее» больше нет, на
    // его месте отправка, и вопроса второй страницы не существует.
    await expect(p.locator('button.rf-next')).toHaveCount(0)
    await expect(p.getByText(PHONE)).toHaveCount(0)
    await expect(p.locator('button.rf-submit')).toBeVisible()

    await p.locator('label.rf-option', { hasText: 'Ничего' }).click()
    await expect(p.getByRole('checkbox', { name: 'Ничего' })).toBeChecked()
    await p.waitForTimeout(3500) // антиспам фазы 5: отправка не раньше 3 с
    await p.locator('button.rf-submit').click()
    await expect(p.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()
    await p.goto('about:blank')
    await ctx.close()
  }

  // ── Ветка «есть питомец»: длинный путь с условной обязательностью ─────────────
  {
    const { ctx, p } = await openForm()
    await p.locator('label.rf-option', { hasText: 'Да' }).click()
    await expect(p.getByRole('radio', { name: 'Да' })).toBeChecked()

    // Вопрос появился и стал обязательным: звёздочка у подписи — та самая, что считается
    // по плану, а не по флагу документа.
    await expect(p.getByText(KIND)).toBeVisible()
    await expect(p.locator('.rf-required')).toHaveCount(1)
    // Скрытый вариант появился в списке.
    await expect(p.getByRole('checkbox', { name: 'Поводок' })).toBeVisible()

    // «Далее» не пускает: условная обязательность держит шаг ровно как обычная.
    await p.locator('button.rf-next').click()
    await expect(p.getByText('Обязательное поле')).toHaveCount(1)

    await p.getByLabel(KIND).fill('Кот')
    await p.locator('label.rf-option', { hasText: 'Поводок' }).click()
    await expect(p.getByRole('checkbox', { name: 'Поводок' })).toBeChecked()
    await p.locator('button.rf-next').click()

    // Вторая страница открылась — переход не сработал (ответ «да»).
    await expect(p.getByLabel(PHONE)).toBeVisible()
    await p.getByLabel(PHONE).fill('+7 999 000 00 00')
    await p.waitForTimeout(3500)
    await p.locator('button.rf-submit').click()
    await expect(p.getByRole('heading', { name: 'Спасибо!' })).toBeVisible()
    await p.goto('about:blank')
    await ctx.close()
  }

  // ── Подделанный ответ: сервер считает видимость сам ──────────────────────────
  // Единственная проверка инварианта «не доверяем клиенту» на живом стеке: шлём ответ на
  // СКРЫТЫЙ вопрос и выбор СКРЫТОГО варианта в обход рендерера. Сервер обязан принять
  // (респондент не виноват, что успел их набрать до переключения источника) и не сохранить.
  //
  // Токен берём настоящий — из публичной выдачи формы: с пустым антиспам отклонит запрос
  // раньше, чем дело дойдёт до нормализации, и проверка выродилась бы в проверку антиспама.
  const publicForm = await page.request.get(`${RENDERER}/public/v1/forms/${form.slug}`)
  expect(publicForm.ok()).toBeTruthy()
  const { token } = (await publicForm.json()) as { token: string }
  await page.waitForTimeout(3500) // тот же антиспам: не раньше 3 с от выдачи

  const forged = await page.request.post(`${RENDERER}/public/v1/forms/${form.slug}/submissions`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      submission_id: crypto.randomUUID(),
      token,
      answers: { pet: 'no', kind: 'Тайный кот', stuff: ['leash', 'nothing'] },
    },
  })
  expect(forged.status()).toBe(201)

  // ── Кабинет: в данных нет того, чего респондент не видел ─────────────────────
  await page.goto(`/forms/${form.slug}/responses`)
  const rows = page.getByRole('button', { name: 'Открыть' })
  await expect(rows).toHaveCount(3)

  // Свежайший ответ — подделанный: «Тайного кота» в нём нет, «Поводка» тоже. Оба значения
  // пришли в теле запроса и оба вычищены нормализацией на приёме.
  await rows.first().click()
  await expect(page.getByText('Ничего')).toBeVisible()
  await expect(page.getByText('Тайный кот')).toHaveCount(0)
  await expect(page.getByText('Поводок')).toHaveCount(0)

  // ── Сводка: знаменатель «вопрос показали» ────────────────────────────────────
  await page.goto(`/forms/${form.slug}/summary`)
  const kindCard = page.getByRole('article').filter({ hasText: KIND })
  // Вопрос показали одному из трёх — и на карточке это сказано прямым текстом, иначе
  // «1 из 1» рядом с «3 ответа» читается как поломка.
  await expect(kindCard).toContainText('Ответили 1 из 1')
  await expect(kindCard).toContainText('вопрос показали 1 из 3')
})
