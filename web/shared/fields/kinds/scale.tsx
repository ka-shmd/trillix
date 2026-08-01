import { scaleRange } from '@entities/formSchema'

import { type Control, textValue } from './contract'

// Шкала: ряд кнопок-делений от min до max (диапазон — из настроек блока). Ответ хранится
// строкой с целым числом — как number и date (конвенция проекта), поэтому тип Answer не
// расширяется.
//
// Настоящие <button>, а не radio: нажатие сразу даёт значение, а группу радио пришлось бы
// обходить стрелками. Выбранное деление помечается aria-pressed — скринридер читает
// состояние.
export const scaleControl: Control = (p) => {
  const value = textValue(p.value)
  const { min, max } = scaleRange(p.block)
  const marks = Array.from({ length: max - min + 1 }, (_, i) => min + i)
  return (
    <div className="rf-scale" role="group" aria-label={p.label} onBlur={p.onBlur}>
      {marks.map((n) => {
        const selected = value === String(n)
        return (
          <button
            key={n}
            type="button"
            className={`rf-scale-mark${selected ? ' rf-scale-mark--on' : ''}`}
            aria-pressed={selected}
            disabled={p.disabled}
            // Повторное нажатие снимает выбор: иначе необязательную шкалу нельзя было бы
            // очистить, промахнувшись.
            onClick={() => p.onChange?.(selected ? '' : String(n))}
          >
            {n}
          </button>
        )
      })}
    </div>
  )
}
