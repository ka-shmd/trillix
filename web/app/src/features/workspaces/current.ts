import { useQuery, type QueryClient } from '@tanstack/react-query'

import { useCurrentWorkspaceSlug } from '../../shared/currentWorkspace'
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
// `undefined` означает «ПОКА НЕ ЗНАЮ» и покрывает три случая: список ещё едет,
// список не приехал вовсе, slug в адресе не наш (чужое или удалённое
// пространство). Вызывающий обязан в этом состоянии не действовать, а не
// подставлять личное: молчаливый откат в личное положил бы форму не туда.
//
// Адрес БЕЗ slug — это личное пространство, и оно ищется по пометке isPersonal,
// а не как первое в списке: список сортируется по возрасту по всем пространствам
// с членством, включая чужие, которые старше моей регистрации.
export function useCurrentWorkspace(): Workspace | undefined {
  const slug = useCurrentWorkspaceSlug()
  const workspaces = useQuery(workspacesQueryOptions)
  return workspaces.data?.find((w) => (slug === '' ? w.isPersonal : w.slug === slug))
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
export async function resolveWorkspaceId(qc: QueryClient, slug: string): Promise<string | undefined> {
  // Адрес пространства не называет — личное, и сервер трактует отсутствие
  // параметра так же. Списка для этого спрашивать незачем.
  if (slug === '') return undefined
  const workspaces = await qc.ensureQueryData(workspacesQueryOptions)
  const found = workspaces.find((w) => w.slug === slug)
  if (!found) throw new Error(`Пространство «${slug}» недоступно`)
  return found.id
}
