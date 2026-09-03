import { useState } from 'react'

import {
  MAX_SCHEDULE_NAME_LEN,
  timezoneOptions,
  type Availability,
  type Schedule,
  type ScheduleInput,
} from '../../entities/schedule'
import { availabilityError } from './weekly'
import { WeekEditor } from './WeekEditor'
import { ExceptionsEditor } from './ExceptionsEditor'
import { Section } from '../../shared/page/Section'
import { PageFooter } from '../../shared/page/PageFooter'
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

// Экран расписания: правило приёма, параметры нарезки, исключения. Сохраняется
// ОДНОЙ кнопкой в подвале — это одно действие на страницу целиком, ради которого
// подвал и существует. Блокировки и записи живут своими разделами и своими
// ручками: они не часть настройки, а состояние.
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
  const [draft, setDraft] = useState<ScheduleInput>(() => toInput(schedule))
  // Сравнение с сохранённым — по содержимому: копия объекта в состоянии не равна
  // исходному по ссылке, и «изменено» горело бы всегда.
  const dirty = JSON.stringify(draft) !== JSON.stringify(toInput(schedule))
  const ruleError = availabilityError(draft.availability)
  const nameError = draft.name.trim() === '' ? 'Имя расписания обязательно' : null
  const seatsError =
    draft.maxSeatsPerBooking > draft.capacity
      ? 'Мест в одной записи не может быть больше вместимости'
      : null
  const blocked = ruleError !== null || nameError !== null || seatsError !== null

  function patch(next: Partial<ScheduleInput>) {
    setDraft((prev) => ({ ...prev, ...next }))
  }

  return (
    <div className="flex flex-col gap-12">
      <Section
        title="Приём"
        description="Часы, в которые к вам можно записаться. Перерыв — это второе окно в дне."
      >
        <WeekEditor
          value={draft.availability}
          onChange={(availability: Availability) => patch({ availability })}
        />
      </Section>

      <Section
        title="Параметры записи"
        description="Как режется сетка времени и сколько человек помещается в один приём."
      >
        <div className="grid gap-5 @2xl:grid-cols-2">
          <Field label="Название" hint="Называйте по тому, КТО принимает: «Мария — рисование».
            Появится второй мастер — сразу видно, что ему нужно своё расписание." error={nameError}>
            <Input
              value={draft.name}
              maxLength={MAX_SCHEDULE_NAME_LEN}
              aria-invalid={nameError !== null}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>

          <Field label="Часовой пояс" hint="Часы приёма заданы в этом поясе. Респондент увидит время в своём.">
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

          <Field label="Перерыв между приёмами" hint="Минут после встречи. Входит в шаг сетки, но не в саму встречу.">
            <NumberInput
              value={draft.bufferMinutes}
              min={0}
              max={1440}
              onChange={(bufferMinutes) => patch({ bufferMinutes })}
            />
          </Field>

          <Field label="Горизонт записи" hint="На сколько дней вперёд открыта запись, считая сегодняшний.">
            <NumberInput
              value={draft.horizonDays}
              min={1}
              max={365}
              onChange={(horizonDays) => patch({ horizonDays })}
            />
          </Field>

          <Field label="Не записывать позже чем за" hint="Минут до начала приёма. Два часа — это 120.">
            <NumberInput
              value={draft.leadMinutes}
              min={0}
              onChange={(leadMinutes) => patch({ leadMinutes })}
            />
          </Field>

          <Field label="Мест в одном приёме" hint="Больше одного — это групповое занятие.">
            <NumberInput
              value={draft.capacity}
              min={1}
              onChange={(capacity) => patch({ capacity })}
            />
          </Field>

          <Field
            label="Мест в одной записи"
            hint="Сколько мест человек может занять сразу — «приду с двумя детьми»."
            error={seatsError}
          >
            <NumberInput
              value={draft.maxSeatsPerBooking}
              min={1}
              invalid={seatsError !== null}
              onChange={(maxSeatsPerBooking) => patch({ maxSeatsPerBooking })}
            />
          </Field>
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

      <Section
        title="Исключения по датам"
        description="День из этого списка живёт по своим правилам, а не по недельным."
      >
        <ExceptionsEditor
          value={draft.availability}
          onChange={(availability) => patch({ availability })}
        />
      </Section>

      <PageFooter>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {error && (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {error}
            </p>
          )}
          {!error && ruleError && (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {ruleError.message}
            </p>
          )}
          {dirty && !blocked && !error && (
            <span className="mr-auto text-sm text-muted-foreground">Есть несохранённые правки</span>
          )}
          <Button disabled={!dirty || blocked || saving} onClick={() => onSave(draft)}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </div>
      </PageFooter>
    </div>
  )
}

// toInput — что из расписания правит автор: всё, кроме назначенного сервером.
// Перечислением, а не выбрасыванием служебных полей: новое поле обязано попасть
// сюда осознанно, иначе оно молча не сохранялось бы.
function toInput(s: Schedule): ScheduleInput {
  return {
    name: s.name,
    timezone: s.timezone,
    availability: s.availability,
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
