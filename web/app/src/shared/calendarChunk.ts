// Тип, а не значение: `import type` стирается сборкой, а обычный импорт остался бы
// СТАТИЧЕСКИМ и молча вернул бы библиотеку в общий чанк — ленивая граница исчезла бы,
// не сломав ничего видимого (rolldown говорит об этом предупреждением
// INEFFECTIVE_DYNAMIC_IMPORT, и оно единственное, что об этом сообщает).
import type { Calendar } from '@/components/ui/calendar'

// Чанк календаря (react-day-picker) — загрузка и запомненный модуль. Отдельно от
// компонентов-обёрток (lazyCalendar.tsx): файл компонента не экспортирует функций,
// иначе ломается fast refresh.
let loaded: typeof Calendar | undefined

// preloadCalendar начинает загрузку чанка, не рисуя ничего. Повторный вызов ничего не
// стоит: модуль браузер грузит один раз.
export function preloadCalendar(): Promise<typeof Calendar> {
  return import('@/components/ui/calendar').then((m) => {
    loaded = m.Calendar
    return m.Calendar
  })
}

// loadedCalendar — модуль, если чанк уже приехал.
export function loadedCalendar(): typeof Calendar | undefined {
  return loaded
}
