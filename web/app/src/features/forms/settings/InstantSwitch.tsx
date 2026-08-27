import { useState } from 'react'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

// Тумблер настройки формы, который показывает своё положение НЕМЕДЛЕННО.
//
// Зачем отдельный компонент. У НОВОЙ формы за одним кликом стоят два запроса
// подряд — сначала создание самой формы (ленивое создание, features/forms/draft.ts),
// потом PATCH настройки. Переключатель, контролируемый серверным значением, всё это
// время стоит в старом положении: со стороны это «клик не сработал», а после
// перезахода, где запрос остаётся один, — рывок.
//
// Правило: положение после клика держит ЛОКАЛЬНОЕ состояние и сбрасывается только
// при ОШИБКЕ — тогда возвращается серверное значение, потому что тумблер не имеет
// права показывать настройку, которой на сервере нет. При успехе локальное значение
// остаётся: серверное подтянется само, и моргать на стыке нечем.
//
// onToggle обязан БРОСИТЬ при неудаче — иначе тумблер останется в положении, до
// которого сервер не доехал.
export function InstantSwitch({
  id,
  label,
  checked,
  disabled,
  onToggle,
}: {
  id: string
  label: string
  checked: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => Promise<void>
}) {
  const [pending, setPending] = useState<boolean | null>(null)
  const shown = pending ?? checked

  return (
    <div className="flex items-center gap-3">
      <Switch
        id={id}
        checked={shown}
        disabled={disabled}
        onCheckedChange={(enabled) => {
          setPending(enabled)
          void onToggle(enabled).catch(() => setPending(null))
        }}
      />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
    </div>
  )
}
