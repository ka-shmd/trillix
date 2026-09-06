import { useState } from 'react'

import {
  MAX_SCHEDULE_NAME_LEN,
  timezoneOptions,
  type Schedule,
  type ScheduleInput,
} from '../../entities/schedule'
import { clampSeats } from './weekly'
import { SETTINGS_TITLE } from './settingNames'
import { Section } from '../../shared/page/Section'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Параметры записи: как режется сетка и сколько человек помещается в приём.
// Живут в шторке страницы расписания и сохраняются ОДНОЙ кнопкой — это настройка, а
// не жест.
//
// ЧАСОВ ПРИЁМА ЗДЕСЬ НЕТ, и это не упущение: правило и исключения правятся мышью на
// полотне недели выше (ScheduleCanvas) и уходят на сервер сразу. Черновик этой формы
// документ правила НЕ ВЕЗЁТ — иначе «Сохранить», нажатое после правки полотна,
// вернуло бы правило к тому, каким оно было при открытии страницы.
export function ScheduleEditor({
  schedule,
  onSave,
  saving,
  error,
}: {
  schedule: Schedule
  onSave: (input: ScheduleInput) => void
  saving: boolean
  error?: string
}) {
  const [draft, setDraft] = useState<Settings>(() => toSettings(schedule))
  // Сравнение с сохранённым — по содержимому: копия объекта в состоянии не равна
  // исходному по ссылке, и «изменено» горело бы всегда.
  const dirty = JSON.stringify(draft) !== JSON.stringify(toSettings(schedule))
  const nameError = draft.name.trim() === '' ? 'Имя расписания обязательно' : null
  const seatsError =
    draft.maxSeatsPerBooking > draft.capacity
      ? 'Мест в одной записи не может быть больше вместимости'
      : null
  const blocked = nameError !== null || seatsError !== null

  function patch(next: Partial<Settings>) {
    setDraft((prev) => ({ ...prev, ...next }))
  }

  return (
    <div className="flex flex-col gap-6">
      <Section
        title={SETTINGS_TITLE}
        description="Как режется сетка времени и сколько человек помещается в один приём."
      >
        <div className="grid gap-5 @2xl:grid-cols-2">
          <Field
            label="Название"
            hint="Называйте по тому, КТО принимает: «Мария — рисование».
            Появится второй мастер — сразу видно, что ему нужно своё расписание."
            error={nameError}
          >
            <Input
              value={draft.name}
              maxLength={MAX_SCHEDULE_NAME_LEN}
              aria-invalid={nameError !== null}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>

          <Field
            label="Часовой пояс"
            hint="Часы приёма заданы в этом поясе. Респондент увидит время в своём."
          >
            <Select value={draft.timezone} onValueChange={(timezone) => patch({ timezone })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timezoneOptions(draft.timezone).map((z) => (
                  <SelectItem key={z.value} value={z.value}>
                    {z.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Длительность приёма" hint="Минут на одну встречу.">
            <NumberInput
              value={draft.slotMinutes}
              min={1}
              max={1440}
              onChange={(slotMinutes) => patch({ slotMinutes })}
            />
          </Field>

          <Field
            label="Перерыв между приёмами"
            hint="Минут после встречи. Входит в шаг сетки, но не в саму встречу."
          >
            <NumberInput
              value={draft.bufferMinutes}
              min={0}
              max={1440}
              onChange={(bufferMinutes) => patch({ bufferMinutes })}
            />
          </Field>

          <Field
            label="Горизонт записи"
            hint="На сколько дней вперёд открыта запись, считая сегодняшний."
          >
            <NumberInput
              value={draft.horizonDays}
              min={1}
              max={365}
              onChange={(horizonDays) => patch({ horizonDays })}
            />
          </Field>

          <Field
            label="Не записывать позже чем за"
            hint="Минут до начала приёма. Два часа — это 120."
          >
            <NumberInput
              value={draft.leadMinutes}
              min={0}
              onChange={(leadMinutes) => patch({ leadMinutes })}
            />
          </Field>

          <Field
            label="Мест в одном приёме"
            hint="Сколько человек помещается в одно время. Больше одного — это групповое занятие."
          >
            <NumberInput
              value={draft.capacity}
              min={1}
              // Вместимость ЗАЖИМАЕТ второе поле: иначе снижение восьми мест до одного
              // оставляло бы в документе «до трёх мест в записи» — невыразимое
              // состояние, о котором сервер отказал бы, показав ошибку у поля,
              // которого на экране уже нет.
              onChange={(capacity) =>
                patch({
                  capacity,
                  maxSeatsPerBooking: clampSeats(draft.maxSeatsPerBooking, capacity),
                })
              }
            />
          </Field>

          {/* ПОЛЕ ЕСТЬ ТОЛЬКО У ГРУППЫ (решение владельца 2026-09-03): при вместимости
              1 «взять два места из одного» невыразимо, и строка стоит на экране
              мёртвой. У подавляющего большинства авторов настройки тут не будет
              вовсе. */}
          {draft.capacity > 1 && (
            <Field
              label="Мест в одной записи"
              hint="Сколько мест один человек может занять сразу — «приду с двумя детьми»."
              error={seatsError}
            >
              <NumberInput
                value={draft.maxSeatsPerBooking}
                min={1}
                max={draft.capacity}
                invalid={seatsError !== null}
                onChange={(maxSeatsPerBooking) => patch({ maxSeatsPerBooking })}
              />
            </Field>
          )}
        </div>

        <label className="flex items-start justify-between gap-4 rounded-lg border p-4">
          <span className="min-w-0">
            <span className="text-sm font-semibold">Показывать остаток мест</span>
            {/* Настройка управляет ПОКАЗОМ, а не доступностью числа: пикеру остаток
                нужен всегда, иначе он не погасит слот, куда запрошенные места не
                влезают. Говорим это прямо — иначе автор решит, что скрыл загрузку. */}
            <span className="mt-1 block text-sm text-muted-foreground">
              «Осталось 2 места» рядом со временем. Выключенная настройка убирает надпись, но само
              число остаётся доступным в данных формы.
            </span>
          </span>
          <Switch
            checked={draft.showRemaining}
            onCheckedChange={(showRemaining) => patch({ showRemaining })}
          />
        </label>
      </Section>

      {/* Кнопка стоит В ПОТОКЕ шторки, а не в подвале страницы: подвал приклеен к
          нижнему краю ОБОЛОЧКИ и тянется во всю её ширину — под открытой шторкой он
          читался бы как действие страницы, а не этих настроек. */}
      <div className="sticky bottom-0 -mx-1 border-t bg-background px-1 py-3">
        <div className="flex flex-wrap items-center justify-end gap-3">
          {error && (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {error}
            </p>
          )}
          {dirty && !blocked && !error && (
            <span className="mr-auto text-sm text-muted-foreground">Есть несохранённые правки</span>
          )}
          <Button
            disabled={!dirty || blocked || saving}
            // Правило берётся из ЖИВОГО расписания, а не из черновика: полотно правит
            // его своими запросами, и черновик, снятый при открытии страницы, откатил
            // бы всё, что автор нарисовал.
            onClick={() => onSave({ ...draft, availability: schedule.availability })}
          >
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// Settings — то, что правит ЭТА форма: всё, кроме документа правила (он живёт на
// полотне) и назначенного сервером.
type Settings = Omit<ScheduleInput, 'availability'>

// toSettings — перечислением, а не выбрасыванием служебных полей: новое поле обязано
// попасть сюда осознанно, иначе оно молча не сохранялось бы.
function toSettings(s: Schedule): Settings {
  return {
    name: s.name,
    timezone: s.timezone,
    slotMinutes: s.slotMinutes,
    bufferMinutes: s.bufferMinutes,
    horizonDays: s.horizonDays,
    leadMinutes: s.leadMinutes,
    capacity: s.capacity,
    maxSeatsPerBooking: s.maxSeatsPerBooking,
    showRemaining: s.showRemaining,
  }
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        hint && <p className="text-sm text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}

// NumberInput — число с границами. Пустое поле НЕ превращается в ноль на каждый
// удалённый символ: иначе стереть «60», чтобы набрать «45», было бы нельзя — поле
// показывало бы «0» после первого же Backspace.
function NumberInput({
  value,
  min,
  max,
  invalid,
  onChange,
}: {
  value: number
  min: number
  max?: number
  invalid?: boolean
  onChange: (value: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      aria-invalid={invalid}
      value={text ?? String(value)}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value !== '' && Number.isFinite(n)) onChange(n)
      }}
      onBlur={() => setText(null)}
    />
  )
}
