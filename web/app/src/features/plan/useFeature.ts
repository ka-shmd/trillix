import { useQuery } from '@tanstack/react-query'

import { useCurrentWorkspaceId } from '../../shared/currentWorkspace'
import { workspacesQueryOptions } from '../workspaces/queries'
import { planSnapshotQueryOptions } from './queries'

// «Можно ли этому пространству такую возможность» — один вопрос вместо трёх
// (какое пространство текущее → снимок его тарифа → найти ключ), которые иначе
// повторялись бы у каждого экрана с гейтом.
//
// ПОКА НЕ ЗНАЕМ — РАЗРЕШЕНО. Замок, мигнувший у платящего автора на каждом открытии
// панели, стоит дороже, чем секунда без замка у бесплатного: настоящий гейт всё
// равно на бэке (инвариант 3, «фронт прячет ради UX, бэк отказывает ради правды»).
// По той же причине сбой запроса тарифа ничего не запирает.
//
// Пространство берётся из адреса (?w=), пустое значит личное — и ищется оно ПО
// ПОМЕТКЕ, а не как первое в списке: список сортируется по возрасту по всем
// пространствам с членством, включая чужие, которые старше моей регистрации.
export function useFeatureAllowed(key: string): boolean {
  const current = useCurrentWorkspaceId()
  const workspaces = useQuery(workspacesQueryOptions)
  const workspaceId = current || workspaces.data?.find((w) => w.isPersonal)?.id
  const plan = useQuery({
    ...planSnapshotQueryOptions(workspaceId ?? ''),
    enabled: workspaceId !== undefined,
  })
  const feature = plan.data?.features.find((f) => f.key === key)
  return feature?.allowed ?? true
}
