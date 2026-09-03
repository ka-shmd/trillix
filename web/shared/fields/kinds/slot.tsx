import { useEffect, useState, type ComponentType } from 'react'

import { useSlotSource, useSlotZone } from '../booking'
import { LOCALE } from '../locale'
import { type SlotPickerProps } from '../slots/SlotPicker'
import { type Control, type ControlProps, textValue } from './contract'

// Запись на время. У контрола две половины, и граница между ними — граница ЗАГРУЗКИ.
//
// СТАТИЧЕСКАЯ ПОЛОВИНА (здесь): плашка с выбранным временем или приглашением. Её видят
// полотно редактора, превью и печатный лист — там живого выбора нет и быть не должно.
//
// ЖИВОЙ ВЫБОР — за динамическим импортом (ADR §10): список дат и времён качает только
// тот, кто открыл форму с вопросом о записи. Бюджет рендерера — 45 КиБ gzip, и запаса
// в нём меньше двух; пикер уезжает своим чанком под префиксом slots/ со своим порогом
// 12 КиБ (web/renderer/scripts/check-bundle.mjs).
//
// ⚠ ИМПОРТ ДОЛЖЕН ОСТАТЬСЯ ДИНАМИЧЕСКИМ. Обычный `import` вернёт пикер в общий чанк и
// не сломает ничего видимого — бюджет упадёт на сборке, и это единственный признак.
// Тип пикера тянется `import type` — он стирается сборкой и границу не снимает.
//
// ⚠ И БЕЗ lazy/Suspense, хотя они для этого и придуманы. Замер: React.lazy из
// preact/compat добавил общему бандлу 2,3 КиБ gzip — больше, чем весит сам вынесенный
// чанк (1,9). Граница загрузки, которая тяжелее того, что уносит, — это не граница.
// Здесь ровно то же самое пятнадцатью строками: промис импорта в состоянии.
function useSlotPicker(): ComponentType<SlotPickerProps> | null {
  const [picker, setPicker] = useState<ComponentType<SlotPickerProps> | null>(null)
  useEffect(() => {
    let alive = true
    void import('../slots/SlotPicker').then((m) => {
      // setState функцией-обновителем вернул бы САМ компонент как обновитель —
      // отсюда обёртка: React зовёт функцию, а не хранит её.
      if (alive) setPicker(() => m.default)
    })
    return () => {
      alive = false
    }
  }, [])
  return picker
}

// ⚠ У ЗНАЧЕНИЯ ДВА ФОРМАТА (design/booking.md §5.6): id брони — то, что шлёт браузер
// респондента, и время RFC3339 — то, что пишет сервер. Показывать здесь можно только
// второе; id человеку не значит ничего, поэтому неразобранное значение показывается
// приглашением, а не сырой строкой.
export const slotControl: Control = (p) => <SlotField {...p} />

function SlotField(p: ControlProps) {
  const source = useSlotSource()
  const Picker = useSlotPicker()
  const value = textValue(p.value)

  // Источника нет — поверхность без живого выбора (полотно, превью, печать). Он же
  // отсутствует у формы без расписания: тогда вопрос честно ничего не предлагает.
  // Пикер ещё едет — плашка стоит на его месте, ростом с него: скачок размера на
  // глазах у респондента дороже пары строк разметки.
  if (!source || p.disabled || p.readOnly || !Picker) return <SlotPlate value={value} />

  return (
    <Picker
      source={source}
      value={value}
      onChange={(bookingId) => p.onChange?.(bookingId)}
      label={p.label}
      invalid={p.invalid}
      errorId={p.errorId}
    />
  )
}

// SlotPlate — вид вопроса ТАМ, ГДЕ ВЫБИРАТЬ НЕЧЕГО: пока едет пикер, в печатном листе
// и на полотне редактора (builder/kinds/slotControl.tsx надевает её же). Экспортируется
// ради последней: полотно обязано показывать ровно то, что увидит респондент, а вторая
// копия этих шести строк разъехалась бы с первой при первой же правке вида.
export function SlotPlate({ value, className = '' }: { value: string; className?: string }) {
  const at = readTime(value, useSlotZone())
  return (
    <div className={className === '' ? 'rf-slot' : `rf-slot ${className}`}>
      {at ? (
        <span className="rf-slot-value">{at}</span>
      ) : (
        <span className="rf-slot-empty">Выбор времени записи</span>
      )}
    </div>
  )
}

// readTime — время записи словами. Пояс задаёт SlotZoneProvider: пусто — читаем в
// поясе смотрящего (живая форма, полотно), названный — пишем в нём и НАЗЫВАЕМ его,
// как письмо о записи. Лист печати читает никто не знает где, и «11:00» без пояса
// на бумаге — это утверждение, которое нечем проверить.
function readTime(raw: string, timeZone: string): string | null {
  if (raw === '') return null
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return null
  // Пустой пояс отдаём как undefined — для Intl это «пояс читателя», то же, что
  // было до печатного листа.
  const text = at.toLocaleString(LOCALE, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timeZone || undefined,
  })
  return timeZone === '' ? text : `${text} (${timeZone})`
}

// ControlProps здесь не разворачивается в свой тип: контрол обязан принимать ровно то,
// что даёт реестр (kinds/index.ts), и лишнее поле в подписи разошлось бы с ним молча.
export type { ControlProps }
