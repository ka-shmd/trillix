// Выборщик цвета для панели форматирования (фаза 14, этап 14.4; вид — решение владельца
// 2026-07-27, ориентир Untitled UI). Сверху вниз: квадрат насыщенности/яркости, полоса
// тона, полоса плотности, сетка готовых цветов, поле hex.
//
// Почему свой, а не библиотека. Сначала стоял системный `<input type="color">` — он
// выпадал из вида кабинета; потом `react-colorful` — от неё отказались тем же решением
// владельца, зависимость снята. Правило web/CLAUDE.md «интерфейс кабинета — только
// shadcn» тут выполняется буквой: shadcn своего выборщика цвета не даёт, а всё, из чего
// этот собран, — Input, Button и токены темы.
//
// Схема хранит `#rrggbb` без альфы (ADR §10), поэтому полоса плотности — НЕ прозрачность
// в модели: она смешивает цвет с белым прямо здесь, и наружу всё равно уходит плотный
// hex. Это честно ровно потому, что холст публичной формы всегда белый (там же, ADR §10):
// что автор видит на полосе, то и получит респондент.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Ban } from 'lucide-react'
import { isHexColor } from '@entities/formSchema'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

interface Hsv {
  h: number
  s: number
  v: number
}

function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const at = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))))
  }
  return [at(5), at(3), at(1)]
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  const h =
    d === 0
      ? 0
      : max === r
        ? 60 * (((g - b) / d) % 6)
        : max === g
          ? 60 * ((b - r) / d + 2)
          : 60 * ((r - g) / d + 4)
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max / 255 }
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')
// Нижний регистр — требование валидатора схемы (HEX_COLOR), а не вкус.
const toHex = (rgb: [number, number, number]) => `#${rgb.map(hex2).join('')}`
const parseHex = (s: string): Hsv | null =>
  isHexColor(s)
    ? rgbToHsv(
        parseInt(s.slice(1, 3), 16),
        parseInt(s.slice(3, 5), 16),
        parseInt(s.slice(5, 7), 16),
      )
    : null

// Плотность применяется смешиванием с белым — альфы в схеме нет (см. шапку файла).
const flatten = (hsv: Hsv, density: number): string =>
  toHex(
    hsvToRgb(hsv).map((c) => Math.round(c * density + 255 * (1 - density))) as [
      number,
      number,
      number,
    ],
  )

// Область, по которой водят мышью. Общая для квадрата и обеих полос: у них различается
// только то, какие координаты они читают.
//
// `preventDefault` на pointerdown — то же правило 1 панели форматирования: без него
// фокус уходит из строки полотна, выделение схлопывается, и красить становится нечего.
// Захват указателя нужен, чтобы курсор можно было увести за границы области и вернуть,
// не теряя перетаскивания.
//
// Две вещи здесь — про скорость, и обе не косметические. За каждым движением стоит весь
// путь «модель → DOM строки → стор → полотно», поэтому лишняя работа тут стоит дорого:
//
//   1. Кадровая склейка. `pointermove` прилетает чаще, чем браузер рисует (125 Гц у
//      обычной мыши, больше у тачпада и игровых), и без склейки бо́льшая часть этой
//      цепочки выполняется впустую — результат затирается следующим событием до того,
//      как его успели показать. Считаем ровно один раз на кадр, по последней позиции.
//   2. Прямоугольник области снимается ОДИН раз за жест. `getBoundingClientRect`
//      посреди движения — принудительный пересчёт лэйаута на каждом кадре, а область
//      никуда не едет: прокрутка на время панели заперта.
function useDragArea(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null)
  const frame = useRef<number | null>(null)
  const box = useRef<DOMRect | null>(null)
  // Своё «жест идёт», а не `hasPointerCapture`: захват указателя есть не в каждой среде,
  // и там, где его нет, движения молча игнорировались бы целиком.
  const dragging = useRef(false)

  const track = (e: PointerEvent<HTMLDivElement>) => {
    const r = box.current
    if (!r?.width || !r.height) return
    const x = clamp01((e.clientX - r.left) / r.width)
    const y = clamp01((e.clientY - r.top) / r.height)
    const win = ref.current?.ownerDocument.defaultView
    if (!win) return
    if (frame.current !== null) win.cancelAnimationFrame(frame.current)
    frame.current = win.requestAnimationFrame(() => {
      frame.current = null
      onMove(x, y)
    })
  }

  // Незакрытый кадр после размонтирования (поповер закрыли посреди жеста) — попытка
  // покрасить то, чего уже нет.
  useEffect(
    () => () => {
      const win = ref.current?.ownerDocument.defaultView
      if (frame.current !== null) win?.cancelAnimationFrame(frame.current)
    },
    [],
  )

  return {
    ref,
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragging.current = true
      box.current = e.currentTarget.getBoundingClientRect()
      e.currentTarget.setPointerCapture?.(e.pointerId)
      track(e)
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      track(e)
    },
    // Отложенный кадр здесь НЕ отменяется: в нём лежит последняя позиция указателя, и
    // отмена потеряла бы конец жеста — цвет остался бы на предпоследнем значении.
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      dragging.current = false
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    },
    onPointerCancel: () => {
      dragging.current = false
    },
  }
}

// Шаг стрелками. Полотно клавиатурное целиком (фаза 13), выборщик — не исключение:
// в квадрат и полосы можно войти табом и работать стрелками.
const arrowStep = (e: KeyboardEvent, step: number): { dx: number; dy: number } | null => {
  const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0
  const dy = e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0
  return dx || dy ? { dx, dy } : null
}

export interface ColorPickerProps {
  // Цвет, с которого открывается выборщик.
  initial: string
  // Зовётся на каждое движение: выделение под поповером перекрашивается сразу, и автор
  // выбирает по результату, а не вслепую.
  onChange: (hex: string) => void
  // Снятие цвета — кнопкой рядом с полем hex. Без onRemove кнопки нет: у окна обложки
  // удаление своё, в углу окна, и второе рядом с полем повторяло бы его.
  onRemove?: () => void
  swatches: readonly string[]
  // Подпись кнопки снятия цвета: у текста и фона она разная.
  removeLabel?: string
}

export function ColorPicker({
  initial,
  onChange,
  onRemove,
  swatches,
  removeLabel,
}: ColorPickerProps) {
  const [hsv, setHsv] = useState<Hsv>(() => parseHex(initial) ?? { h: 220, s: 0.9, v: 0.85 })
  const [density, setDensity] = useState(1)
  // Черновик поля hex отдельно от цвета: пока автор дописывает «#7c3», значение ещё не
  // цвет, и подставлять его в модель нельзя. null — «поле показывает текущий цвет».
  const [draft, setDraft] = useState<string | null>(null)

  const current = flatten(hsv, density)
  const pure = toHex(hsvToRgb(hsv))

  const emit = (next: Hsv, nextDensity = density) => {
    setHsv(next)
    setDensity(nextDensity)
    setDraft(null)
    onChange(flatten(next, nextDensity))
  }

  const square = useDragArea((x, y) => emit({ ...hsv, s: x, v: 1 - y }))
  const hue = useDragArea((x) => emit({ ...hsv, h: x * 360 }))
  const dense = useDragArea((x) => emit(hsv, x))

  const applyHex = (value: string) => {
    const next = parseHex(value.trim().toLowerCase())
    if (!next) return
    emit(next, 1)
  }

  return (
    <div className="flex w-56 flex-col gap-2">
      {/* Квадрат: по горизонтали насыщенность, по вертикали яркость. Оба градиента
          лежат поверх чистого тона — так же, как это рисует любой выборщик. */}
      <div
        {...square}
        role="slider"
        aria-label="Насыщенность и яркость"
        aria-valuetext={`насыщенность ${Math.round(hsv.s * 100)}%, яркость ${Math.round(hsv.v * 100)}%`}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = arrowStep(e, 0.02)
          if (!step) return
          e.preventDefault()
          emit({ ...hsv, s: clamp01(hsv.s + step.dx), v: clamp01(hsv.v - step.dy) })
        }}
        className="relative aspect-square w-full cursor-crosshair touch-none rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        style={{
          backgroundColor: `hsl(${hsv.h} 100% 50%)`,
          backgroundImage:
            'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
        }}
      >
        <Thumb x={hsv.s} y={1 - hsv.v} color={pure} />
      </div>

      <div
        {...hue}
        role="slider"
        aria-label="Тон"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = arrowStep(e, 4)
          if (!step) return
          e.preventDefault()
          emit({ ...hsv, h: (hsv.h + step.dx + step.dy + 360) % 360 })
        }}
        className="relative h-3 w-full touch-none rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        style={{
          backgroundImage:
            'linear-gradient(to right, #f00, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00)',
        }}
      >
        <Thumb x={hsv.h / 360} y={0.5} color={`hsl(${hsv.h} 100% 50%)`} />
      </div>

      <div
        {...dense}
        role="slider"
        aria-label="Плотность"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(density * 100)}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = arrowStep(e, 0.04)
          if (!step) return
          e.preventDefault()
          emit(hsv, clamp01(density + step.dx + step.dy))
        }}
        className="relative h-3 w-full touch-none rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        style={{ backgroundImage: `linear-gradient(to right, #fff, ${pure})` }}
      >
        <Thumb x={density} y={0.5} color={current} />
      </div>

      <div className="grid grid-cols-8 gap-1">
        {swatches.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            title={c}
            style={{ backgroundColor: c }}
            className="size-5 rounded border border-black/10 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            // Тот же гард, что у панели: образец фокус не забирает, выделение цело.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyHex(c)}
          />
        ))}
      </div>

      <div className="flex items-center gap-1">
        <span
          aria-hidden="true"
          className="size-7 shrink-0 rounded-lg border"
          style={{ backgroundColor: current }}
        />
        <Input
          value={draft ?? current}
          aria-label="Свой цвет"
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value)
            applyHex(e.target.value)
          }}
          // Поле фокус берёт намеренно — как поле адреса ссылки: диапазон выделения уже
          // лежит в состоянии строки, схлопывание живого ему не вредит.
          onMouseDown={(e) => e.stopPropagation()}
          className="h-7 flex-1 font-mono text-sm"
        />
        {onRemove && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={removeLabel}
            title={removeLabel}
            className="size-7 text-muted-foreground"
            onClick={onRemove}
          >
            <Ban className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

// Бегунок — один на все три области: белое кольцо с текущим цветом внутри.
function Thumb({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.25)]"
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, backgroundColor: color }}
    />
  )
}
