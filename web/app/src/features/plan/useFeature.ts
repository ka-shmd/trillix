import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { useCurrentWorkspace } from '../workspaces/current'
import { planKeys } from './keys'
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
// Пространство берётся из адреса либо из самой формы — что из двух, решает
// `shared/workspaceContext.tsx`; перевод slug'а в id делает useCurrentWorkspace.
export function useFeatureAllowed(key: string): boolean {
  const workspace = useCurrentWorkspace()
  const plan = useQuery({
    ...planSnapshotQueryOptions(workspace?.id ?? ''),
    enabled: workspace !== undefined,
  })
  const feature = plan.data?.features.find((f) => f.key === key)
  return feature?.allowed ?? true
}

// Квота тарифа числами: сколько израсходовано и сколько разрешено. Соседка
// useFeatureAllowed для ключей вида `quota`, у которых вопрос не «можно ли», а
// «сколько осталось».
//
// `undefined` означает «ПОКА НЕ ЗНАЮ» — снимок ещё едет, не приехал или пространство
// не разрезолвилось. Рисовать в этом состоянии «0 из 0» нельзя: число, которого нет,
// пугает сильнее, чем его отсутствие. `limit: null` — безлимит.
//
// refresh обязателен рядом со значением: расход меняется действиями самого автора на
// том же экране (каждая реплика ассистенту — минус одна), и без обновления индикатор
// показывал бы число, верное на момент открытия.
export function usePlanQuota(key: string):
  | {
      used: number
      limit: number | null
      refresh: () => void
    }
  | undefined {
  const workspace = useCurrentWorkspace()
  const qc = useQueryClient()
  const workspaceId = workspace?.id ?? ''
  const plan = useQuery({
    ...planSnapshotQueryOptions(workspaceId),
    enabled: workspace !== undefined,
  })
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: planKeys.snapshot(workspaceId) })
  }, [qc, workspaceId])

  const feature = plan.data?.features.find((f) => f.key === key)
  if (feature === undefined || feature.kind !== 'quota') return undefined
  return { used: feature.used, limit: feature.limit, refresh }
}
