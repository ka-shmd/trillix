import { queryOptions } from '@tanstack/react-query'

import { planKeys } from './keys'
import { getPlanSnapshot } from './api'

// Снимок тарифа — серверный стейт, живёт только в Query. Расход меняется с каждым
// принятым ответом, поэтому staleTime короткий: страница «Тариф» открывается редко,
// а показывать на ней вчерашнее число нельзя.
export function planSnapshotQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: planKeys.snapshot(workspaceId),
    queryFn: () => getPlanSnapshot(workspaceId),
  })
}
