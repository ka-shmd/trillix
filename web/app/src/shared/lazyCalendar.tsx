import { lazy, Suspense, useState, type ComponentProps } from 'react'

import type { Calendar } from '@/components/ui/calendar'
import { Skeleton } from '@/components/ui/skeleton'
import { loadedCalendar, preloadCalendar } from './calendarChunk'

// ГРАНИЦА ЗАГРУЗКИ react-day-picker — та же мера и по тому же доводу, что у recharts
// (features/insights/lazyCharts.tsx). Живёт в shared, а не в фиче: календарь нужен
// двум фичам (дата закрытия формы и даты расписания), а импорт фичи из фичи запрещён. Библиотека весит около 22 КиБ gzip, а нужна на
// ОДНОЙ строке настроек, и открывается она по клику: до этого клика грузить её
// незачем ни на дашборде, ни в редакторе, ни на самой странице настроек.
//
// Импортируй календарь ОТСЮДА, а не из `@/components/ui/calendar` напрямую: прямой
// импорт втащит библиотеку обратно в общий чанк, и заметит это только замер сборки
// (`vite build`) — работать будет одинаково.
const CalendarImpl = lazy(() => preloadCalendar().then((component) => ({ default: component })))

// LazyCalendar — календарь во всплывающей панели. Заглушка ростом с сам календарь:
// скачок размера панели на глазах у человека дороже сотни байт разметки.
export function LazyCalendar(props: ComponentProps<typeof Calendar>) {
  return (
    <Suspense fallback={<Skeleton className="m-3 h-64 w-64" />}>
      <CalendarImpl {...props} />
    </Suspense>
  )
}

// InlineCalendar — календарь БЕЗ своей заглушки, для экрана, который появляется одним
// кадром (страница расписания, решение владельца 2026-09-14). Загруженный заранее
// (`preloadCalendar`) рисуется синхронно; не загруженный — приостанавливается до
// границы Suspense вызывающего. Даже загруженный заранее `lazy` на первом рендере
// приостанавливается на такт, а React придерживает показ выпавшей границы — отсюда
// синхронная ветка.
//
// ⚠ Выбор фиксируется на МОНТИРОВАНИЕ: смена типа компонента между рендерами
// перемонтировала бы календарь и сбросила его месяц.
export function InlineCalendar(props: ComponentProps<typeof Calendar>) {
  const [Impl] = useState(() => loadedCalendar() ?? CalendarImpl)
  return <Impl {...props} />
}
