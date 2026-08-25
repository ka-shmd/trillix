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

  // Пространство на обзоре — секция с заголовком, а не строка списка. Отдельного
  // экрана участников больше нет: состав живёт в диалоге, который открывают
  // кластер кружков у правого края строки и пункт «Участники» в меню «…».
  await expect(page.getByRole('heading', { name: spaceName })).toBeVisible()
  await page.getByRole('button', { name: `Участники пространства «${spaceName}»` }).click()

  const members = page.getByRole('dialog', { name: `Участники: ${spaceName}` })
  await expect(members).toBeVisible()
  await members.getByPlaceholder('coworker@example.com').fill(mateEmail)
  await members.getByRole('button', { name: 'Пригласить' }).click()
  await expect(members.getByText('Приглашение отправлено')).toBeVisible()
  // Позванный виден в том же окне ещё до принятия — это состояние пространства,
  // а не невидимая очередь.
  await expect(members.getByText(mateEmail)).toBeVisible()

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

  // После принятия он оказывается в списке форм ЭТОГО пространства.
  await expect(matePage).toHaveURL(/\/forms\?w=/)
  // Пространство в адресе называется своим slug'ом — тем же, которым кабинет
  // адресует его везде. Дальше он нужен, чтобы прийти на чужой тариф напрямую.
  const spaceSlug = new URL(matePage.url()).searchParams.get('w') ?? ''
  expect(spaceSlug).not.toBe('')

  // Формы правит: заводит свою прямо в общем пространстве. Кнопка только открывает
  // полотно — форму создаёт первая правка (ленивое создание, EDITOR.md §18), поэтому
  // доказательство права писать здесь — смена сентинела в адресе на настоящий slug.
  // Кнопка берётся из сайдбара: «Новая форма» есть ещё и на самой странице форм
  // (в шапке и в пустом состоянии), а exact отсекает «Новая форма в пространстве
  // «…»» — «+» у каждого пространства в том же сайдбаре.
  await matePage
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Новая форма', exact: true })
    .click()
  await expect(matePage).toHaveURL(/\/forms\/new\/edit\?.*w=/)
  await matePage.getByLabel('Название формы').fill('Форма коллеги')
  await expect(matePage).not.toHaveURL(/\/forms\/new\/edit/)

  // --- Права: управление составом и тариф редактору закрыты ---
  await matePage.goto('/workspaces')
  await matePage.getByRole('button', { name: `Участники пространства «${spaceName}»` }).click()
  const mateMembers = matePage.getByRole('dialog', { name: `Участники: ${spaceName}` })
  // Ждём приехавший состав ПЕРЕД проверками отсутствия: диалог спрашивает права
  // только у открытого окна (`enabled: open`), и на ещё не пришедшем ответе
  // «кнопок нет» выполнилось бы даже у владельца.
  await expect(mateMembers.getByText(ownerEmail)).toBeVisible()
  // Кнопок управления участниками у редактора нет — кабинет прячет их по
  // permissions с сервера, а не по роли, вычисленной на фронте.
  await expect(mateMembers.getByRole('button', { name: 'Пригласить' })).toHaveCount(0)
  await expect(mateMembers.getByRole('button', { name: 'Снять доступ' })).toHaveCount(0)

  // Тариф чужого пространства не отдаёт сам сервер (billing.view — только
  // владельцу), и прячется он не кнопкой: приходим по прямому адресу.
  await matePage.goto(`/settings/plan?w=${spaceSlug}`)
  await expect(matePage.getByText('Не удалось загрузить тариф.')).toBeVisible()

  // --- Владелец отзывает доступ ---
  // Перезагрузка нужна за данными: коллега принял приглашение в другом контексте,
  // и до перечитывания состава он у владельца всё ещё «приглашён, но не вошёл».
  // Диалог её не переживает (состояние экрана, а не адреса) — открываем заново.
  await page.reload()
  await page.getByRole('button', { name: `Участники пространства «${spaceName}»` }).click()
  await members.getByRole('button', { name: `Снять доступ: ${mateEmail}` }).click()
  await expect(members.getByText(mateEmail)).toHaveCount(0)

  // --- У коллеги пространство исчезло ---
  await matePage.goto('/workspaces')
  await expect(matePage.getByText(spaceName)).toHaveCount(0)

  await mateContext.close()
})
