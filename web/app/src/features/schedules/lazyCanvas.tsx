import { lazy, Suspense, type ComponentProps } from 'react'

// Тип, а не значение: `import type` стирается сборкой, а обычный импорт остался бы
// СТАТИЧЕСКИМ и молча вернул бы FullCalendar в общий чанк — ленивая граница исчезла
// бы, не сломав ничего видимого (сборка говорит об этом предупреждением
// INEFFECTIVE_DYNAMIC_IMPORT, и оно единственное, что об этом сообщает).
import type { ScheduleCanvas } from './ScheduleCanvas'
import type { RuleCanvas } from './RuleCanvas'
import { Skeleton } from '@/components/ui/skeleton'

// ГРАНИЦА ЗАГРУЗКИ FullCalendar — та же мера и по тому же доводу, что у recharts и
// react-day-picker (web/CLAUDE.md). Библиотека тяжёлая, а нужна на ОДНОМ экране
// кабинета: на дашборде, в редакторе и в настройках формы её быть не должно.
//
// Импортируй полотна ОТСЮДА, а не из ./ScheduleCanvas и ./RuleCanvas напрямую.
//
// ДВЕ ГРАНИЦЫ, А НЕ ОДНА: поверхности показываются по очереди, и качать обе разом
// незачем. Сама библиотека при этом уезжает в общий для них чанк — её импортируют
// оба модуля, и сборщик выносит такое сам; вторая вкладка догружает только свою
// сотню строк.
//
// Заглушка ростом с само полотно: оно занимает главную часть экрана, и скачок её
// размера на глазах у автора дороже сотни байт разметки.
const CanvasImpl = lazy(() =>
  import('./ScheduleCanvas').then((m) => ({ default: m.ScheduleCanvas })),
)

const RuleImpl = lazy(() => import('./RuleCanvas').then((m) => ({ default: m.RuleCanvas })))

export function LazyScheduleCanvas(props: ComponentProps<typeof ScheduleCanvas>) {
  return (
    <Suspense fallback={<Skeleton className="h-[36rem] w-full" />}>
      <CanvasImpl {...props} />
    </Suspense>
  )
}

export function LazyRuleCanvas(props: ComponentProps<typeof RuleCanvas>) {
  return (
    <Suspense fallback={<Skeleton className="h-[36rem] w-full" />}>
      <RuleImpl {...props} />
    </Suspense>
  )
}
