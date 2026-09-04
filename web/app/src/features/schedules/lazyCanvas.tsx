import { lazy, Suspense, type ComponentProps } from 'react'

// Тип, а не значение: `import type` стирается сборкой, а обычный импорт остался бы
// СТАТИЧЕСКИМ и молча вернул бы FullCalendar в общий чанк — ленивая граница исчезла
// бы, не сломав ничего видимого (сборка говорит об этом предупреждением
// INEFFECTIVE_DYNAMIC_IMPORT, и оно единственное, что об этом сообщает).
import type { ScheduleCanvas } from './ScheduleCanvas'
import { Skeleton } from '@/components/ui/skeleton'

// ГРАНИЦА ЗАГРУЗКИ FullCalendar — та же мера и по тому же доводу, что у recharts и
// react-day-picker (web/CLAUDE.md). Библиотека тяжёлая, а нужна на ОДНОМ экране
// кабинета: на дашборде, в редакторе и в настройках формы её быть не должно.
//
// Импортируй полотно ОТСЮДА, а не из ./ScheduleCanvas напрямую.
//
// Заглушка ростом с само полотно: оно занимает главную часть экрана, и скачок её
// размера на глазах у автора дороже сотни байт разметки.
const CanvasImpl = lazy(() =>
  import('./ScheduleCanvas').then((m) => ({ default: m.ScheduleCanvas })),
)

export function LazyScheduleCanvas(props: ComponentProps<typeof ScheduleCanvas>) {
  return (
    <Suspense fallback={<Skeleton className="h-[36rem] w-full" />}>
      <CanvasImpl {...props} />
    </Suspense>
  )
}
