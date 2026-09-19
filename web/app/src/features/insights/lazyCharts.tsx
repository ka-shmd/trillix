import { lazy, Suspense } from 'react'

import { type BucketStep, type LabelCount, type TimeBucket } from '../../entities/visitsBreakdown'
import { type ScalePoint } from '../../entities/summary'
import { Skeleton } from '@/components/ui/skeleton'

// ГРАНИЦА ЗАГРУЗКИ recharts. Библиотека тянет за собой около 116 КиБ gzip — треть
// всего бандла кабинета, — а нужна на трёх вкладках одной формы. Через lazy она
// уезжает в отдельный чанк и не грузится ни на дашборде, ни в редакторе, ни в
// настройках.
//
// Импортируй графики ОТСЮДА, а не из соседних файлов напрямую: прямой импорт из
// VisitsChart/ShareChart/ScaleTrendChart втащит recharts обратно в общий чанк, и
// проверка этого — только замер сборки (`npm run build`), потому что работать
// будет одинаково.
//
// Воронки здесь нет и не должно появиться: с фазы 30 она нарисована разметкой
// (features/insights/Funnel.tsx), и «Обзор» — единственная вкладка аналитики,
// которая не грузит recharts вовсе.
//
// Заглушка каждого графика ростом с сам график: скачок раскладки на месте, где
// человек уже читает числа, дороже лишней сотни байт разметки.

const VisitsChartImpl = lazy(() =>
  import('./VisitsChart').then((m) => ({ default: m.VisitsChart })),
)
const ShareChartImpl = lazy(() => import('./ShareChart').then((m) => ({ default: m.ShareChart })))
const ScaleTrendChartImpl = lazy(() =>
  import('./ScaleTrendChart').then((m) => ({ default: m.ScaleTrendChart })),
)

export function VisitsChart(props: { buckets: TimeBucket[]; step: BucketStep }) {
  return (
    <Suspense fallback={<Skeleton className="h-60 w-full" />}>
      <VisitsChartImpl {...props} />
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

export function ScaleTrendChart(props: {
  points: ScalePoint[]
  step: BucketStep
  min: number
  max: number
}) {
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full" />}>
      <ScaleTrendChartImpl {...props} />
    </Suspense>
  )
}
