// Поле в окнах интеграций (вебхук, Google Таблицы): выше общего — 40 вместо 32 — и с
// заметной тенью, которая на наведении чуть растёт (решения владельца 2026-09-14).
//
// Тень темнее штатной за счёт цвета (`shadow-black/20`), а не другой ступени: ступень
// меняет и размер, и на наведении растёт уже она (`shadow-sm` → `shadow-md`). Переход
// анимирует штатный `transition-[color,box-shadow]` компонентов.
//
// Вертикальный паддинг снят: высоту держит h-10, а текст кегля 16 центрируется сам.
// Высота и кегль перебиваются ТЕМИ ЖЕ вариантами, что у вендора: у списка высота —
// `data-[size=default]:h-8`, у Input кегль — `md:text-sm`.
const SHADOW = 'shadow-sm shadow-black/20 hover:shadow-md hover:shadow-black/20'
export const INTEGRATION_INPUT = `h-10 py-0 md:text-base ${SHADOW}`
export const INTEGRATION_SELECT = `data-[size=default]:h-10 py-0 text-base ${SHADOW}`
// Кнопки в одном ряду с таким полем — его роста: ряд ровняется по нарисованному.
export const INTEGRATION_ROW_BUTTON = 'h-10'
export const INTEGRATION_ROW_ICON = 'size-10'
