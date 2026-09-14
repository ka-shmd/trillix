import { lazy, useState, type ComponentProps } from 'react'

import type { ScheduleCanvas } from './ScheduleCanvas'
import { loadedScheduleCanvas, preloadScheduleCanvas } from './canvasChunk'

// ГРАНИЦА ЗАГРУЗКИ FullCalendar — та же мера и по тому же доводу, что у recharts и
// react-day-picker (web/CLAUDE.md). Библиотека тяжёлая, а нужна на ОДНОМ экране
// кабинета: на дашборде, в редакторе и в настройках формы её быть не должно.
//
// Импортируй полотно ОТСЮДА, а не из ./ScheduleCanvas напрямую.
//
// Своей заглушки у полотна НЕТ (решение владельца 2026-09-14): страница расписания
// появляется одним кадром — полоса и полотно вместе, без скелетов по частям. Чанк
// грузится заранее (`preloadScheduleCanvas`: список расписаний и loader страницы), а
// ждёт полотно общая граница Suspense страницы.
const CanvasImpl = lazy(() => preloadScheduleCanvas().then((component) => ({ default: component })))

// LazyScheduleCanvas рисует полотно СИНХРОННО, если чанк уже загружен, и
// приостанавливается до общей границы страницы, если нет. Даже загруженный заранее
// `lazy` на первом рендере приостанавливается на такт, а React придерживает показ
// выпавшей границы — отсюда синхронная ветка.
//
// ⚠ Выбор фиксируется на МОНТИРОВАНИЕ: смена типа компонента между рендерами
// перемонтировала бы полотно, и оно потеряло бы неделю, вид и открытые попапы.
export function LazyScheduleCanvas(props: ComponentProps<typeof ScheduleCanvas>) {
  const [Impl] = useState(() => loadedScheduleCanvas() ?? CanvasImpl)
  return <Impl {...props} />
}
