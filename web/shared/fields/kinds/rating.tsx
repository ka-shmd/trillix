import { ratingCount } from '@entities/formSchema'

import { type Control, textValue } from './contract'

// Рейтинг: ряд звёзд от 1 до N (число — из настроек блока). Ответ — строка с целым числом,
// как у шкалы, и проверяется так же.
//
// Звезда — настоящий <button>, как деление шкалы: нажатие сразу даёт оценку, повторное
// нажатие на выставленную её снимает (иначе необязательный рейтинг не очистить).
// Закрашены звёзды до выставленной; подсветку «до курсора» рисует CSS (.rf-rating в
// fields.css), поэтому состояния наведения у контрола нет.
export const ratingControl: Control = (p) => {
  const value = Number(textValue(p.value)) || 0
  const count = ratingCount(p.block)
  const stars = Array.from({ length: count }, (_, i) => i + 1)
  return (
    <div className="rf-rating" role="group" aria-label={p.label} onBlur={p.onBlur}>
      {stars.map((n) => (
        <button
          key={n}
          type="button"
          className={`rf-rating-star${n <= value ? ' rf-rating-star--on' : ''}`}
          aria-label={`${n} из ${count}`}
          aria-pressed={n === value}
          disabled={p.disabled}
          onClick={() => p.onChange?.(n === value ? '' : String(n))}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.49l-5.87 3.09 1.12-6.54L2.5 9.41l6.56-.95z" />
          </svg>
        </button>
      ))}
    </div>
  )
}
