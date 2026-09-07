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

// СВЕЧЕНИЕ ФОКУСА В ПОПАПЕ СНЯТО (решение владельца 2026-09-07). Вендоренные контролы
// рисуют вокруг себя кольцо в 3px (`focus-visible:ring-[3px]`) — на странице настроек
// это заметная и уместная метка, а в попапе шириной 22rem кольцо вылезает за строку и
// перекрывает соседние. Фокус при этом НЕ становится невидимым: у тех же вендоренных
// контролов на фокусе перекрашивается рамка (`focus-visible:border-ring`), и она
// остаётся — снимается только свечение.
//
// Кольцо гасится нулём, а не `ring-transparent`: прозрачное кольцо всё равно занимает
// место и продолжает раздвигать соседей.
const SETTING_FOCUS = 'focus-visible:ring-0'

// SettingRow — подпись слева, контрол справа. Подпись — настоящий <label> только у
// одиночного контрола (htmlFor); у пары (диапазон шкалы: «от» и «до») подписи свои у
// каждого select'а, поэтому строка ограничивается текстом-заголовком.
//
// `px-3` зеркалит отступ пункта cmdk (`p-1` у группы + `px-2` у пункта = 12px):
// строки настроек стоят в том же поповере, что и пункты меню, и при другом значении
// подписи разъезжаются с ними по левому краю. Значение ритма §5 здесь ни при чём —
// это выравнивание по вендоренному компоненту.
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
    <div className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-muted-foreground shrink-0">
          {label}
        </label>
      ) : (
        <span className="text-muted-foreground shrink-0">{label}</span>
      )}
      <div className="flex min-w-0 items-center gap-2">{children}</div>
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
        className={`h-7 text-sm ${SETTING_FOCUS}`}
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


// КОМПАКТНЫЕ СЕЛЕКТЫ ПОПАПА (решение владельца 2026-09-07). Вендоренный select
// рассчитан на страницу настроек: у триггера px-3/py-2 при высоте 36px, у пункта
// списка py-1.5 и pr-8 под галочку. В попапе блока контролы стоят в узкой колонке
// рядом с подписью, и эти отступы делают из «от 1 до 5» три пухлые кнопки.
//
// КЛАССАМИ НА МЕСТЕ, А НЕ ПРАВКОЙ components/ui/select.tsx: тот вендоренный компонент
// держит весь кабинет (web/CLAUDE.md), и ужать его ради одного попапа значит поменять
// вид форм и настроек на всех экранах разом.
//
// pr-6 — НИЖНИЙ ПРЕДЕЛ, а не круглое число: галочка выбранного пункта стоит абсолютом
// в right-2 и занимает 14px, поэтому меньше 24px справа она наезжает на текст.
//
// МИНА: высота обязана перебиваться ВАРИАНТНЫМ классом (`data-[size=sm]:h-7`), а не
// голым `h-7`. У триггера высота задана правилом `data-[size=sm]:h-8`, то есть классом
// ПЛЮС атрибутом — специфичность (0,2,0) против (0,1,0) у голой утилиты, и порядок в
// строке ничего не решает (web/CLAUDE.md, «конфликтующие Tailwind-утилиты»). Ровно так
// прежний `h-7` у селектов шкалы и не работал: класс стоял, высота оставалась 32px.
// Отступы перебиваются просто — `px-3 py-2` у вендора голые, их сливает tailwind-merge.
export const SETTING_SELECT = `data-[size=sm]:h-7 px-2 py-1 ${SETTING_FOCUS}`
export const SETTING_SELECT_ITEM = 'py-1 pr-6'

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
      <SelectTrigger size="sm" className={`w-16 ${SETTING_SELECT}`} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((n) => (
          <SelectItem key={n} value={String(n)} className={SETTING_SELECT_ITEM}>
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
