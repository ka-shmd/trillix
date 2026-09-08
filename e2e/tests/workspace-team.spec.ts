import { test, expect } from '@playwright/test'
import { login, seedAccount } from './helpers/session'

// Совместная работа в пространстве (фаза 18) против prod-local: приглашение,
// принятие вторым человеком, разграничение прав, отзыв доступа.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СЦЕНАРИЙ, а не дописать в full-loop: здесь нужны ДВА
// одновременных пользователя в двух браузерных контекстах и переход по ссылке из
// письма. Пришив это к сборке формы кликами по редактору, мы получили бы длинный
// тест, который краснеет от правок билдера, ничего не говоря про совместную
// работу. Та же причина, по которой отдельными сделаны form-settings и
// visits-funnel.
//
// ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ ВПЕРВЫЕ (юниты и интеграционные не видят этой границы):
//   1. Ссылка приглашения из ПИСЬМА действительно работает в прод-сборке: токен
//      живёт в query, экран /invite лежит ВНЕ гарда сессии, и проверить, что он
//      открывается неавторизованным, можно только настоящим браузером.
//   2. Прод-CSP и same-origin: мутации кабинета несут Origin и CSRF-куку — под
//      Caddy это работает иначе, чем в dev, где CSP нет вовсе.
//   3. Разграничение прав ГЛАЗАМИ: у редактора нет кнопок управления
//      участниками, потому что кабинет прячет их по permissions с сервера, а
//      тариф чужого пространства ему не отдаёт сам сервер.
//
// ПИСЬМО ЧИТАЕТСЯ ИЗ MAILPIT — того же, куда prod-local шлёт всю почту. Так
// проверяется весь путь «токен → outbox → SMTP → ссылка», а не суррогат с
// токеном, вынутым из базы.
const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025'

// inviteLinkFor вытаскивает ссылку приглашения из последнего письма адресату.
// Диспетчер outbox работает фоном, поэтому ждём появления письма, а не берём
// «что есть сейчас».
async function inviteLinkFor(request: import('@playwright/test').APIRequestContext, email: string) {
  let link = ''
  await expect
    .poll(
      async () => {
        const res = await request.get(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
        )
        if (!res.ok()) return ''
        const found = (await res.json()) as { messages?: Array<{ ID: string }> }
        const id = found.messages?.[0]?.ID
        if (!id) return ''
        const body = await request.get(`${MAILPIT}/api/v1/message/${id}`)
        if (!body.ok()) return ''
        const msg = (await body.json()) as { Text?: string }
        const match = /https?:\/\/\S*\/invite\?token=\S+/.exec(msg.Text ?? '')
        link = match?.[0] ?? ''
        return link
      },
      { timeout: 30_000, message: 'письмо приглашения не пришло в Mailpit' },
    )
    .not.toBe('')
  return link
}

test('приглашение в пространство: коллега принял, правит формы, тариф ему закрыт, отзыв убирает доступ', async ({
  page,
  browser,
}) => {
  const ownerEmail = seedAccount('ws-owner')
  const mateEmail = seedAccount('ws-mate')
  const spaceName = `Пространство ${Date.now()}`

  // --- Владелец: заводит пространство и зовёт коллегу ---
  await login(page, ownerEmail)
  await page.goto('/workspaces')

  // Создание — диалогом, а не формой на странице. Кнопка-открывашка есть и в
  // шапке обзора (портал в headerSlot), и в блоке сайдбара, поэтому берётся по
  // месту: <header> кабинета один, и роль banner ему не досталась — он лежит
  // внутри <main> оболочки.
  await page.locator('header').getByRole('button', { name: 'Новое пространство' }).click()
  const createDialog = page.getByRole('dialog', { name: 'Новое пространство' })
  await createDialog.getByPlaceholder('Например, «Отдел маркетинга»').fill(spaceName)
  await createDialog.getByRole('button', { name: 'Создать' }).click()

  // Пространство на обзоре — строка со ссылкой в него. Состав — СТРАНИЦА раздела
  // (`/w/{slug}/members`), а не диалог: кластер кружков у правого края строки ведёт
  // туда же, что и пункт сайдбара.
  await expect(page.getByRole('link', { name: spaceName })).toBeVisible()
  await page.getByRole('link', { name: `Участники пространства «${spaceName}»` }).click()

  await expect(page).toHaveURL(/\/w\/[^/]+\/members$/)
  // Приглашение — кнопка в заголовке раздела и диалог (решение владельца
  // 2026-09-08): поле почты в потоке страницы отменено, правило «завести новое —
  // кнопкой» исключений больше не имеет (DESIGN-SYSTEM §1).
  await page.getByRole('button', { name: 'Пригласить' }).click()
  const inviteDialog = page.getByRole('dialog', { name: 'Пригласить в пространство' })
  await inviteDialog.getByPlaceholder('coworker@example.com').fill(mateEmail)
  await inviteDialog.getByRole('button', { name: 'Пригласить' }).click()
  // Позванный виден на той же странице ещё до принятия — это состояние
  // пространства, а не невидимая очередь. Проверяем строку, а не тост: тост
  // исчезает сам, а строка и есть результат действия.
  await expect(page.getByText(mateEmail)).toBeVisible()

  const link = await inviteLinkFor(page.request, mateEmail)

  // --- Коллега: открывает ссылку БЕЗ сессии, потом входит и принимает ---
  const mateContext = await browser.newContext()
  const matePage = await mateContext.newPage()

  await matePage.goto(link)
  // Экран приглашения лежит вне гарда сессии: неавторизованный видит, куда его
  // зовут, и получает предложение войти — а не редирект на /login.
  await expect(matePage.getByRole('heading', { name: new RegExp(spaceName) })).toBeVisible()
  await expect(matePage.getByRole('link', { name: 'Войти' })).toBeVisible()

  await login(matePage, mateEmail)
  await matePage.goto(link)
  await matePage.getByRole('button', { name: 'Принять приглашение' }).click()

  // После принятия он оказывается в списке форм ЭТОГО пространства. Пространство
  // стоит В ПУТИ: параметра `?w=` в кабинете больше нет вовсе — потерянный
  // параметр читался как «личное» молча (docs/design/cabinet-navigation.md).
  await expect(matePage).toHaveURL(/\/w\/[^/]+\/forms$/)
  const spaceSlug = new URL(matePage.url()).pathname.split('/')[2] ?? ''
  expect(spaceSlug).not.toBe('')

  // Формы правит: заводит свою прямо в общем пространстве. Кнопка только открывает
  // полотно — форму создаёт первая правка (ленивое создание, EDITOR.md §18), поэтому
  // доказательство права писать здесь — смена сентинела в адресе на настоящий slug.
  // Кнопка берётся с самой страницы форм: в сайдбаре создания нет. На экране
  // «Новая форма» бывает в двух экземплярах (шапка списка и пустое состояние) —
  // годится любая, обе ведут в редактор ЭТОГО пространства.
  await matePage.getByRole('button', { name: 'Новая форма', exact: true }).first().click()
  await expect(matePage).toHaveURL(new RegExp(`/w/${spaceSlug}/forms/new/edit$`))
  await matePage.getByLabel('Название формы').fill('Форма коллеги')
  await expect(matePage).not.toHaveURL(/\/forms\/new\/edit/)

  // --- Права: управление составом и тариф редактору закрыты ---
  await matePage.goto(`/w/${spaceSlug}/members`)
  // Ждём приехавший состав ПЕРЕД проверками отсутствия: на ещё не пришедшем ответе
  // «кнопок нет» выполнилось бы даже у владельца.
  await expect(matePage.getByText(ownerEmail)).toBeVisible()
  // Кнопок управления участниками у редактора нет — кабинет прячет их по
  // permissions с сервера, а не по роли, вычисленной на фронте.
  await expect(matePage.getByRole('button', { name: 'Пригласить' })).toHaveCount(0)
  // Меню действий над строкой у редактора не рисуется вовсе: снимать доступ и
  // передавать владение ему нельзя, а меню с одним недоступным пунктом обещало бы
  // права, которых нет.
  await expect(matePage.getByRole('button', { name: `Действия: ${ownerEmail}` })).toHaveCount(0)
  await expect(matePage.getByRole('button', { name: 'Снять доступ' })).toHaveCount(0)
  // Пункт «Тариф» в панели есть и у редактора — он про СВОЙ аккаунт, а не про
  // пространство (ADR §10): у коллеги свой план, и смотреть его он вправе.
  await expect(matePage.getByRole('link', { name: 'Тариф' })).toHaveCount(1)

  // Чужой план по-прежнему недоступен, и прячется он не кнопкой: старый адрес
  // тарифа пространства ведёт на аккаунтную страницу — она про план САМОГО
  // спрашивающего и про чужое пространство не говорит ничего.
  await matePage.goto(`/w/${spaceSlug}/plan`)
  await expect(matePage).toHaveURL(/\/settings\/plan$/)
  await expect(matePage.getByRole('heading', { name: 'Тариф' })).toBeVisible()
  await expect(matePage.getByRole('heading', { name: 'Возможности' })).toBeVisible()

  // --- Владелец отзывает доступ ---
  // Перезагрузка нужна за данными: коллега принял приглашение в другом контексте,
  // и до перечитывания состава он у владельца всё ещё «приглашён, но не вошёл».
  // Страница состава её переживает — адрес у раздела свой.
  await page.reload()
  // Действия над участником — меню «⋯» в строке, снятие доступа спрашивает
  // подтверждение: оно необратимо и вернуть человека можно только приглашением
  // (DESIGN-SYSTEM §7).
  await page.getByRole('button', { name: `Действия: ${mateEmail}` }).click()
  await page.getByRole('menuitem', { name: 'Снять доступ' }).click()
  await page
    .getByRole('alertdialog', { name: `Снять доступ: ${mateEmail}?` })
    .getByRole('button', { name: 'Снять доступ' })
    .click()
  await expect(page.getByText(mateEmail)).toHaveCount(0)

  // --- У коллеги пространство исчезло ---
  await matePage.goto('/workspaces')
  await expect(matePage.getByText(spaceName)).toHaveCount(0)

  await mateContext.close()
})
