import { lazy, Suspense } from 'react'

import { type BucketStep, type LabelCount, type TimeBucket } from '../../entities/visitsBreakdown'
import { type FunnelRow } from './metrics'
import { Skeleton } from '@/components/ui/skeleton'

// ГРАНИЦА ЗАГРУЗКИ recharts. Библиотека тянет за собой около 116 КиБ gzip — треть
// всего бандла кабинета, — а нужна на трёх вкладках одной формы. Через lazy она
// уезжает в отдельный чанк и не грузится ни на дашборде, ни в редакторе, ни в
// настройках.
//
// Импортируй графики ОТСЮДА, а не из соседних файлов напрямую: прямой импорт из
// VisitsChart/FunnelChart/ShareChart втащит recharts обратно в общий чанк, и
// проверка этого — только замер сборки (`npm run build`), потому что работать
// будет одинаково.
//
// Заглушка каждого графика ростом с сам график: скачок раскладки на месте, где
// человек уже читает числа, дороже лишней сотни байт разметки.

const VisitsChartImpl = lazy(() =>
  import('./VisitsChart').then((m) => ({ default: m.VisitsChart })),
)
const FunnelChartImpl = lazy(() =>
  import('./FunnelChart').then((m) => ({ default: m.FunnelChart })),
)
const ShareChartImpl = lazy(() => import('./ShareChart').then((m) => ({ default: m.ShareChart })))

export function VisitsChart(props: { buckets: TimeBucket[]; step: BucketStep }) {
  return (
    <Suspense fallback={<Skeleton className="h-60 w-full" />}>
      <VisitsChartImpl {...props} />
    </Suspense>
  )
}

export function FunnelChart(props: { rows: FunnelRow[]; base: number }) {
  // Высота воронки считается по числу строк. Число 26 зеркалит ROW_HEIGHT в
  // FunnelChart.tsx — импортировать его оттуда нельзя, импорт значения втащил бы
  // модуль с recharts обратно в общий чанк.
  const height = props.rows.length * 26 + 16
  return (
    <Suspense fallback={<Skeleton className="w-full" style={{ height }} />}>
      <FunnelChartImpl {...props} />
    </Suspense>
  )
}

export function ShareChart(props: { rows: LabelCount[] }) {
  return (
    <Suspense fallback={<Skeleton className="size-32 rounded-full" />}>
      <ShareChartImpl {...props} />
    </Suspense>
  )
}
