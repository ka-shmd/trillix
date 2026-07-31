import { useId, type ReactNode } from 'react'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Готовые строки типового раздела настроек (§3.5 спеки фазы 16). Экономию даёт не
// генератор форм по спеке, а вот этот набор: тип пишет свой раздел обычным JSX, но
// строки у всех типов выглядят и ведут себя одинаково.
//
// Здесь ровно то, что уже понадобилось. `SwitchSetting` появится вместе со своим
// первым потребителем: набор без потребителя — это не заготовка, а код, который никто
// не проверял.

// SettingRow — подпись слева, контрол справа. Подпись — настоящий <label> только у
// одиночного контрола (htmlFor); у пары (диапазон шкалы: «от» и «до») подписи свои у
// каждого select'а, поэтому строка ограничивается текстом-заголовком.
export function SettingRow({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-muted-foreground shrink-0">
          {label}
        </label>
      ) : (
        <span className="text-muted-foreground shrink-0">{label}</span>
      )}
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  )
}

// TextSetting — свободная строка. В отличие от SelectSetting значение здесь не из
// закрытого списка, поэтому правка уезжает в стор на каждый символ (а не по blur):
// склейка истории делает это одним шагом отмены, автосейв — одним PATCH после
// дебаунса, и недособранное состояние ловить нечем — валидатор ограничивает только
// длину.
//
// placeholder несёт СМЫСЛ, а не подсказку-пример: у имени вопроса это буквально та
// строка, которая уйдёт в данные, пока поле пусто (ADR §10, решение 3).
export function TextSetting({
  label,
  value,
  placeholder,
  maxLength,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  maxLength: number
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <SettingRow label={label} htmlFor={id}>
      <Input
        id={id}
        className="h-7 text-sm"
        value={value}
        placeholder={placeholder}
        // Схема отвергает документ длиннее лимита, и без потолка здесь автосейв ловил
        // бы 422 на 101-м символе — правило «невалидное состояние невозможно», то же,
        // по которому диапазон шкалы выбирается списком.
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
    </SettingRow>
  )
}

// SelectSetting — выбор из закрытого списка. Именно select, а не свободный ввод: у
// схемы строгий валидатор (диапазон шкалы — min < max в пределах [0,10]), и свободный
// ввод даёт невалидные промежуточные состояния (пустое поле, min > max посреди набора),
// на каждое из которых автосейв ловил бы 422. Список делает такое состояние
// невозможным — правило `web/shared/fields/README.md`.
export function SelectSetting({
  label,
  value,
  options,
  onChange,
}: {
  // Имя контрола для скринридера: у select'а в попапе нет видимой подписи, кроме
  // короткого «от»/«до» рядом, и без имени он читался бы как «кнопка, 1».
  label: string
  value: number
  options: number[]
  onChange: (value: number) => void
}) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger size="sm" className="h-7 w-16" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
