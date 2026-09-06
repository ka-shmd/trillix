import { useWorkspaceAddress } from './workspaceContext'

// Адрес страницы тарифа. Хук, а не константа: тариф принадлежит ПРОСТРАНСТВУ (квоты
// считаются по нему), и ссылка обязана назвать какому. Пока страница жила по адресу
// `/settings/plan`, все семь ссылок на неё вели в личное — независимо от того, в
// каком пространстве человек упёрся в гейт (`docs/design/cabinet-navigation.md` §2).
//
// Живёт в `shared/`, а не в `features/plan/`: ссылку ставит и `ProTag`, который тоже
// общий, а `shared` в фичи не ходит. Нужного знания здесь ровно столько, сколько уже
// есть у оболочки, — slug текущего пространства.
export function usePlanLink():
  { to: '/w/$workspaceSlug/plan'; params: { workspaceSlug: string } } | { to: '/settings/plan' } {
  const { slug } = useWorkspaceAddress()
  // Пустой slug — «список пространств ещё не приехал» (первый кадр сессии). Ссылка
  // на `/w//plan` в этот момент была бы битой, поэтому ведём на СТАРЫЙ адрес: он
  // остался маршрутом-редиректом и умеет дождаться списка сам.
  if (slug === '') return { to: '/settings/plan' }
  return { to: '/w/$workspaceSlug/plan', params: { workspaceSlug: slug } }
}
