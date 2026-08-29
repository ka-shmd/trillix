import { useRef, type KeyboardEvent } from 'react'
import { Clock } from 'lucide-react'

import { cn } from '@/lib/utils'

// Поле времени в 24 часах — СВОЙ КОНТРОЛ, и это осознанное отступление от правила
// «весь кабинет на shadcn» (web/CLAUDE.md).
//
// Причина в том, что заменять нечем. Тайм-пикера у shadcn/ui нет вовсе, нативный
// `input type="time"` показывает 12 или 24 часа по локали браузера (формат не
// задаётся ни атрибутом, ни CSS — в русском интерфейсе автор мог увидеть «11:59 PM»),
// а два `Select` со списками на 24 и 60 строк — это выбор из простыни там, где
// человек и так знает, что печатать (решение владельца 2026-08-29).
//
// Поле СЕГМЕНТНОЕ: два двузначных окна в одной коробке. Коробка нарисована ровно как
// `Input` (те же граница, высота, кольцо фокуса) — она и должна читаться полем ввода,
// а не панелью из двух полей.
//
// Клавиатура — главный способ ввода, мышь не обязательна: цифры набираются подряд
// (вторая цифра часов сама переводит в минуты), стрелки вверх/вниз крутят значение по
// кругу, Backspace на пустых минутах возвращает в часы.

export function TimeField({
  value,
  onChange,
  disabled,
  invalid,
  className,
}: {
  // Значение «ЧЧ:ММ» либо пустая строка. Промежуточных состояний у поля нет:
  // недобранная цифра дополняется нулём сразу, поэтому наружу всегда уезжает время,
  // которое можно сохранить.
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  className?: string
}) {
  const hours = useRef<HTMLInputElement>(null)
  const minutes = useRef<HTMLInputElement>(null)
  // focus() ПЕРЕД select(): сам по себе select() выделяет текст, но перевод фокуса
  // спецификацией не обещает — в браузере он случается попутно, а в тесте (happy-dom)
  // не случается вовсе, и переход между сегментами оказался бы непроверяемым.
  const focusSegment = (el: HTMLInputElement | null) => {
    el?.focus()
    el?.select()
  }

  // Разбор терпимый к мусору: значение приходит из черновика страницы, а тот
  // склеивается из даты и времени — «10» без минут там законное промежуточное
  // состояние, и падать на нём поле не имеет права.
  const [rawH = '', rawM = ''] = value === '' ? ['', ''] : value.split(':')
  const hh = rawH
  const mm = rawM
  const commit = (h: string, m: string) => onChange(`${pad(h)}:${pad(m)}`)

  // Набор цифр: берём ПОСЛЕДНИЕ две (человек, перепечатывающий поверх, не должен
  // сначала стирать), клампим по потолку сегмента. Переход в минуты — когда часы
  // дописаны: две цифры либо первая цифра, больше которой часа не бывает («3» — это
  // уже 03, второй цифры не будет).
  const typeHours = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(-2)
    if (digits === '') {
      commit('00', mm)
      return
    }
    const n = Math.min(Number(digits), 23)
    commit(String(n), mm)
    if (digits.length === 2 || Number(digits) > 2) focusSegment(minutes.current)
  }

  const typeMinutes = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(-2)
    commit(hh, digits === '' ? '00' : String(Math.min(Number(digits), 59)))
  }

  // Стрелки крутят по кругу: 23 → 00 вверх и 00 → 23 вниз. Крайнее значение,
  // упирающееся в стенку, заставляет прокручивать поле обратно целиком.
  const step = (unit: 'h' | 'm', delta: number) => {
    const max = unit === 'h' ? 24 : 60
    const current = Number((unit === 'h' ? hh : mm) || '0')
    const next = String((current + delta + max) % max)
    if (unit === 'h') commit(next, mm)
    else commit(hh, next)
  }

  // Два обработчика, а не один с параметром: каррированная фабрика, созданная в
  // рендере, для линта React Compiler неотличима от чтения ref'а во время рендера
  // (react-hooks/refs), и правило краснеет на ровном месте.
  const hoursKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      step('h', e.key === 'ArrowUp' ? 1 : -1)
      return
    }
    // Двоеточие и стрелка вправо переводят в минуты — так это поле ведёт себя в
    // любом календаре, и переучивать человека незачем.
    if (e.key === ':' || e.key === 'ArrowRight') {
      e.preventDefault()
      focusSegment(minutes.current)
    }
  }

  const minutesKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      step('m', e.key === 'ArrowUp' ? 1 : -1)
      return
    }
    if (e.key === 'ArrowLeft' || (e.key === 'Backspace' && mm === '00')) {
      e.preventDefault()
      focusSegment(hours.current)
    }
  }

  const segment =
    'w-[2ch] bg-transparent text-center tabular-nums outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed'

  return (
    // Коробка повторяет геометрию `Input`; фокус кольцом обводит ВСЁ поле, а не
    // сегмент, — внутри него человек уже ориентируется кареткой.
    <div
      className={cn(
        'flex h-9 items-center gap-1 rounded-md border border-input bg-transparent px-3 text-base shadow-xs transition-[color,box-shadow] md:text-sm dark:bg-input/30',
        'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        invalid && 'border-destructive ring-destructive/20 dark:ring-destructive/40',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={hours}
        aria-label="Часы"
        inputMode="numeric"
        disabled={disabled}
        placeholder="ЧЧ"
        value={hh}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => typeHours(e.target.value)}
        onKeyDown={hoursKeys}
        className={segment}
      />
      <span aria-hidden className="text-muted-foreground">
        :
      </span>
      <input
        ref={minutes}
        aria-label="Минуты"
        inputMode="numeric"
        disabled={disabled}
        placeholder="ММ"
        value={mm}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => typeMinutes(e.target.value)}
        onKeyDown={minutesKeys}
        className={segment}
      />
    </div>
  )
}

// pad — двузначное представление сегмента. Пустая строка тоже становится «00»:
// половины времени не бывает, и наружу поле отдаёт только целое значение.
function pad(v: string): string {
  return String(Number(v || '0')).padStart(2, '0')
}
