import { useState } from 'react'

import { Input } from '@/components/ui/input'

// NumberRow — число с диапазоном для панели «Оформление». Пустое поле означает «по
// умолчанию», а не ноль: стереть значение автор вправе, и это не то же самое, что
// поставить 0 (у скругления ноль — осмысленный выбор, прямые углы).
//
// ЧЕРНОВИК ОБЯЗАТЕЛЕН, И ЭТО НЕ ПЕРЕСТРАХОВКА. Первая редакция просто не пускала в
// стор значение вне диапазона — и поле стало непригодным для клавиатуры: при
// минимуме 14 набор «1» откатывался к прежнему значению, до «14» дойти было нельзя
// в принципе, Backspace из «16» тоже возвращал «16». Причина в том, что input
// контролируемый: раз состояние не изменилось, React восстанавливает DOM к
// отрендеренному. Поэтому набранный текст живёт здесь, а в стор уходит только
// готовое число — тот же приём, что у поля hex в ColorPicker.
export function NumberRow({
  id,
  value,
  fallback,
  min,
  max,
  disabled,
  onChange,
}: {
  id: string
  value: number | undefined
  fallback: number
  min: number
  max: number
  disabled?: boolean
  onChange: (value: number | undefined) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  // Значение из стора сильнее черновика, когда меняется мимо поля (undo, загрузка
  // формы): сверка в рендере, а не эффектом — тот дал бы лишний каскадный рендер
  // (react-hooks/set-state-in-effect), приём взят у FormSettings.
  const [synced, setSynced] = useState(value)
  if (synced !== value) {
    setSynced(value)
    setDraft(null)
  }

  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      disabled={disabled}
      value={draft ?? (value === undefined ? '' : String(value))}
      placeholder={String(fallback)}
      className="h-8"
      onChange={(e) => {
        const raw = e.currentTarget.value
        setDraft(raw)
        if (raw === '') {
          onChange(undefined)
          return
        }
        const n = Number(raw)
        // Вне диапазона в стор не уходит: контракт его отвергает (422), и автосейв
        // краснел бы прямо во время набора. В поле при этом остаётся набранное.
        if (!Number.isInteger(n) || n < min || n > max) return
        onChange(n)
      }}
      // По уходу фокуса черновик снимается: недобранное «1» не должно остаться
      // висеть в поле, показывая не то, что в документе.
      onBlur={() => setDraft(null)}
    />
  )
}
