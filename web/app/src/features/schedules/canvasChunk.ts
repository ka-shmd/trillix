// Тип, а не значение: `import type` стирается сборкой, а обычный импорт остался бы
// СТАТИЧЕСКИМ и молча вернул бы FullCalendar в общий чанк — ленивая граница исчезла
// бы, не сломав ничего видимого (сборка говорит об этом предупреждением
// INEFFECTIVE_DYNAMIC_IMPORT, и оно единственное, что об этом сообщает).
import type { ScheduleCanvas } from './ScheduleCanvas'

// Чанк полотна (FullCalendar) — загрузка и запомненный модуль. Отдельно от
// компонента-обёртки (lazyCanvas.tsx): файл компонента не экспортирует функций, иначе
// ломается fast refresh.
let loaded: typeof ScheduleCanvas | undefined

// preloadScheduleCanvas начинает загрузку чанка, не рисуя ничего. Повторный вызов
// ничего не стоит: модуль браузер грузит один раз.
export function preloadScheduleCanvas(): Promise<typeof ScheduleCanvas> {
  return import('./ScheduleCanvas').then((m) => {
    loaded = m.ScheduleCanvas
    return m.ScheduleCanvas
  })
}

// loadedScheduleCanvas — модуль, если чанк уже приехал.
export function loadedScheduleCanvas(): typeof ScheduleCanvas | undefined {
  return loaded
}
