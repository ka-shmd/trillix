import { useQuery } from '@tanstack/react-query'

import { useCurrentWorkspace } from '../workspaces/current'
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
// Пространство берётся из адреса (?w= или путь страницы пространства), пустое
// значит личное; перевод slug'а адреса в id для запроса делает useCurrentWorkspace.
export function useFeatureAllowed(key: string): boolean {
  const workspace = useCurrentWorkspace()
  const plan = useQuery({
    ...planSnapshotQueryOptions(workspace?.id ?? ''),
    enabled: workspace !== undefined,
  })
  const feature = plan.data?.features.find((f) => f.key === key)
  return feature?.allowed ?? true
}
