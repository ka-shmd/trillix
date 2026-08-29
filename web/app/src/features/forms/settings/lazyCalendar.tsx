import { lazy, Suspense, type ComponentProps } from 'react'

// Тип, а не значение: `import type` стирается сборкой, а обычный импорт остался бы
// СТАТИЧЕСКИМ и молча вернул бы библиотеку в общий чанк — ленивая граница исчезла бы,
// не сломав ничего видимого (rolldown говорит об этом предупреждением
// INEFFECTIVE_DYNAMIC_IMPORT, и оно единственное, что об этом сообщает).
import type { Calendar } from '@/components/ui/calendar'
import { Skeleton } from '@/components/ui/skeleton'

// ГРАНИЦА ЗАГРУЗКИ react-day-picker — та же мера и по тому же доводу, что у recharts
// (features/insights/lazyCharts.tsx). Библиотека весит около 22 КиБ gzip, а нужна на
// ОДНОЙ строке настроек, и открывается она по клику: до этого клика грузить её
// незачем ни на дашборде, ни в редакторе, ни на самой странице настроек.
//
// Импортируй календарь ОТСЮДА, а не из `@/components/ui/calendar` напрямую: прямой
// импорт втащит библиотеку обратно в общий чанк, и заметит это только замер сборки
// (`vite build`) — работать будет одинаково.
//
// Заглушка ростом с сам календарь: он выезжает во всплывающей панели, и скачок её
// размера на глазах у человека дороже сотни байт разметки.
const CalendarImpl = lazy(() =>
  import('@/components/ui/calendar').then((m) => ({ default: m.Calendar })),
)

export function LazyCalendar(props: ComponentProps<typeof Calendar>) {
  return (
    <Suspense fallback={<Skeleton className="m-3 h-64 w-64" />}>
      <CalendarImpl {...props} />
    </Suspense>
  )
}
