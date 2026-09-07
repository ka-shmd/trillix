import { queryOptions } from '@tanstack/react-query'

import { planKeys } from './keys'
import { getAccountPlan, getPlanSnapshot } from './api'

// Снимок тарифа — серверный стейт, живёт только в Query. Расход меняется с каждым
// принятым ответом, поэтому staleTime короткий: страница «Тариф» открывается редко,
// а показывать на ней вчерашнее число нельзя.
export function planSnapshotQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: planKeys.snapshot(workspaceId),
    queryFn: () => getPlanSnapshot(workspaceId),
  })
}

// Снимок тарифа аккаунта — страница «Тариф». Отдельный ключ от воркспейсного
// снимка, а не производное от него: они отвечают на разные вопросы и приезжают
// разными ручками (аккаунтная знает про все пространства, воркспейсная — про одно).
export function accountPlanQueryOptions() {
  return queryOptions({
    queryKey: planKeys.account(),
    queryFn: getAccountPlan,
  })
}
