import { useState } from 'react'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

// Тумблер сбора незавершённых ответов.
//
// СВОЙ КОМПОНЕНТ, А НЕ ИНЛАЙН В FormSettings, из-за одного свойства: он должен
// показывать своё положение НЕМЕДЛЕННО, не дожидаясь сервера. У новой формы за
// одним кликом стоят два запроса подряд — сначала создание самой формы (ленивое
// создание, features/forms/draft.ts), потом PATCH тумблера, — и всё это время
// контролируемый по серверному значению переключатель стоял бы в старом положении.
// Со стороны это выглядит как «клик не сработал», а после перезахода — как рывок.
//
// Отсюда правило: положение после клика держит ЛОКАЛЬНОЕ состояние, и сбрасывается
// оно только при ОШИБКЕ (тогда возвращается серверное значение — иначе тумблер врал
// бы про сбор, которого нет). При успехе локальное значение остаётся: серверное
// подтянется само, а «моргнуть» на стыке нечем.
export function PartialToggle({
  checked,
  disabled,
  onToggle,
}: {
  checked: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => Promise<void>
}) {
  const [pending, setPending] = useState<boolean | null>(null)
  const shown = pending ?? checked

  return (
    <div className="mt-4 flex items-center gap-3">
      <Switch
        id="collect-partial"
        checked={shown}
        disabled={disabled}
        onCheckedChange={(enabled) => {
          setPending(enabled)
          void onToggle(enabled).catch(() => setPending(null))
        }}
      />
      <Label htmlFor="collect-partial" className="text-sm font-normal">
        Собирать незавершённые ответы
      </Label>
    </div>
  )
}
