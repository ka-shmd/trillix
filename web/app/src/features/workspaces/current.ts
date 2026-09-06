import { useQuery, type QueryClient } from '@tanstack/react-query'

import { useWorkspaceAddress } from '../../shared/workspaceContext'
import type { Workspace } from '../../entities/workspace'
import { workspacesQueryOptions } from './queries'

// Текущее пространство целиком — перевод «как написано в адресе» в «как называть
// его серверу». Адрес несёт slug, запросы API уходят с id: то же разделение, что
// у формы (URL кабинета — form.slug, мутации — form.id).
//
// Резолв идёт по СПИСКУ, а не отдельной ручкой: `GET /workspaces` отдаёт все
// пространства человека разом и уже прочитан сайдбаром на каждом экране, поэтому
// перевод бесплатен. Формы так не умеют — их список постраничный, и потому у них
// есть `/forms/lookup?slug=`.
//
// Откуда берётся сам slug и в каком порядке — `shared/workspaceContext.tsx`.
//
// `undefined` означает «ПОКА НЕ ЗНАЮ»; вызывающий обязан в этом состоянии не
// действовать, а не подставлять личное — молчаливый откат положил бы форму не туда.
export function useCurrentWorkspace(): Workspace | undefined {
  const { slug, named } = useWorkspaceAddress()
  const workspaces = useQuery(workspacesQueryOptions)
  const list = workspaces.data
  if (!list) return undefined

  // Адрес БЕЗ пространства — личное, и оно ищется ПО ПОМЕТКЕ, а не как первое в
  // списке: список сортируется по возрасту по всем пространствам с членством,
  // включая чужие, которые старше моей регистрации.
  if (slug === '') return list.find((w) => w.isPersonal)

  const found = list.find((w) => w.slug === slug)
  if (found) return found

  // МИНА. Названное адресом или формой и не найденное — это «чужое или удалённое»,
  // и ответом обязано быть «не знаю»: страница покажет «нет такого», а создание не
  // случится. Не названное (то есть подсказанное памятью браузера) и не найденное —
  // просто протухшая память, и личное здесь верный ответ.
  return named ? undefined : list.find((w) => w.isPersonal)
}

// Тот же перевод, но В МОМЕНТ ДЕЙСТВИЯ, а не отрисовки: возвращает id для запроса
// или бросает, если пространство названо адресом, но недоступно.
//
// МИНА, РАДИ КОТОРОЙ ЭТА ФУНКЦИЯ И ЖИВЁТ: ленивое создание формы (features/forms/
// draft.ts) зовёт `POST /forms` из автосейва, а не из рендера, и прочитанное на
// рендере «пространство ещё не приехало» означало бы `workspaceId: undefined` —
// то есть форма молча легла бы в ЛИЧНОЕ вместо командного. Здесь список
// дожидается (ensureQueryData), поэтому гонка невозможна: либо id, либо отказ,
// который автосейв покажет и повторит следующей правкой.
//
// Slug сюда передаётся ИЗ ПУТИ маршрута, а не из `useCurrentWorkspace`: черновик
// заводится на `/w/{slug}/forms/new`, и путь — единственный, кто вправе назвать
// место новой формы.
export async function resolveWorkspaceId(qc: QueryClient, slug: string): Promise<string> {
  const workspaces = await qc.ensureQueryData(workspacesQueryOptions)
  const found = workspaces.find((w) => w.slug === slug)
  if (!found) throw new Error(`Пространство «${slug}» недоступно`)
  return found.id
}

// Личное пространство slug'ом — для маршрутов, которым надо КУДА-ТО отправить
// человека, а пространства в адресе нет: корень кабинета и редиректы со старых
// адресов (`/forms`, `/settings/plan`, `/templates`). Ищется по пометке, а не как
// первое в списке, — см. выше.
export async function personalWorkspaceSlug(qc: QueryClient): Promise<string> {
  const workspaces = await qc.ensureQueryData(workspacesQueryOptions)
  const personal = workspaces.find((w) => w.isPersonal)
  // Личное заводится транзакцией регистрации и не удаляется (WORKSPACES.md §2),
  // поэтому его отсутствие — сломанный аккаунт, а не ветка поведения.
  if (!personal) throw new Error('Личное пространство не найдено')
  return personal.slug
}
