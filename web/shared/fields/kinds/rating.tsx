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
          {/* Контур — звезда lucide (ISC) со скруглёнными кончиками, тот же, что значок
              типа в кабинете. Путём, а не импортом: lucide-react рендереру не положен. */}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
          </svg>
        </button>
      ))}
    </div>
  )
}
