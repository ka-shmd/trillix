// Приподнятое поле — окна интеграций (вебхук, Google Таблицы) и панель настроек встраивания:
// выше общего — 40 вместо 32 — и с контуром поля полотна (решения владельца 2026-09-14,
// 2026-09-15). Остальные поля кабинета — штатные 32.
// Ссылка на форму на экране «Поделиться» и ссылка-приглашение на странице участников берут
// контур и текст без роста (`CONTOUR_INPUT`): высота у них штатная 32, как у кнопок их ряда.
//
// Контур — тень, а не border: рамка вендора снята, кольцо края и слои тени рисуют токены
// `--rf-field-shadow` и `--rf-focus-shadow` из web/shared/fields/fields.css — те же, что у
// `.rf-input`, так что поле окна едет за полем полотна. Штатное кольцо фокуса вендора
// погашено: свечение фокуса — внутри `--rf-focus-shadow`. Мина: без `border-0` рамка
// вендора ляжет поверх кольца, и край станет двойным.
//
// Вертикальный паддинг снят: высоту держит h-10, а текст кегля 16 центрируется сам.
// Текст — Inter 16/500 (решение владельца 2026-09-14), и моноширинного нет даже у
// ссылки и секрета: системный моноширинный шрифт разгонял буквы и стоял в строке выше
// Inter, так что текст приходилось сдвигать руками. Семейство наследуется от body.
// Высота и кегль перебиваются ТЕМИ ЖЕ вариантами, что у вендора: у списка высота —
// `data-[size=default]:h-8`, у Input кегль — `md:text-sm`.
// FIELD_CONTOUR отдельно — у полей, которым нужен только контур при штатных размерах и
// кегле (окно «Карточка ссылки»: оба поля и многострочное описание).
// Тень на hover зеркалит `.rf-input.canvas-field:hover` в builder/kinds/fieldWrap.css. Фокус
// её перебивает: вариант `focus-visible` Tailwind ставит после `hover`.
export const FIELD_CONTOUR =
  'border-0 shadow-(--rf-field-shadow) hover:shadow-[0_1px_1px_0_var(--rf-shadow-near),0_0_0_1px_var(--rf-ring),0_4px_12px_0_var(--rf-shadow-far)] focus-visible:ring-0 focus-visible:shadow-(--rf-focus-shadow)'
export const RAISED_INPUT = `h-10 py-0 font-medium md:text-base ${FIELD_CONTOUR}`
export const CONTOUR_INPUT = `py-0 font-medium md:text-base ${FIELD_CONTOUR}`
export const RAISED_SELECT = `data-[size=default]:h-10 py-0 text-base font-medium ${FIELD_CONTOUR}`
// Кнопки в одном ряду с таким полем — его роста: ряд ровняется по нарисованному.
export const RAISED_ROW_BUTTON = 'h-10'
export const RAISED_ROW_ICON = 'size-10'
