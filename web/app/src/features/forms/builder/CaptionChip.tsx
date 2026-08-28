import { useActiveRow } from './activeRow'
import { chords, formatLabel, SHORTCUTS } from './shortcuts'

// CaptionChip — единственная подсказка, оставшаяся у строки полотна (решение
// владельца 2026-07-29). Все прочие чипы сняты: одинаковый хвост клавиш у каждой
// строки читать перестают, а карта целиком живёт в шпаргалке Mod+/ — там она полная и
// не конкурирует с самим документом за внимание.
//
// Этот пункт остался потому, что он не только подсказка: у голой строки ответа нет
// заголовка, и это единственное недостающее действие, которое мышью больше нигде не
// взять. Поэтому чип — настоящая кнопка, а не aria-hidden украшение.
//
// Вне потока (absolute) и без событий у контейнера — закон полотна TD-22: контрол,
// который появляется по фокусу и занимает место в потоке, схлопывается на mousedown,
// всё ниже уезжает вверх, и click приходит мимо цели. Кликается только сам чип.
export function CaptionChip({
  rowId,
  lineH,
  onAddCaption,
}: {
  rowId: string
  // Высота первой строки блока (h-6/h-7): чип обязан стоять на её уровне, как и
  // кластер значков слева. Приходит из BlockRow — она знает тип строки.
  lineH: string
  onAddCaption: () => void
}) {
  const active = useActiveRow()
  // Только у строки под кареткой: чип — предложение действия автору, который сейчас
  // здесь, а не пометка «этот вопрос недособран» на всё полотно.
  if (!active || active.id !== rowId) return null
  // Ярлык клавиши берём из карты, а не пишем рядом ещё раз: подпись на кнопке и
  // обещание шпаргалки обязаны совпадать, а совпадают они только у общего источника.
  const item = SHORTCUTS[active.ctx].find((s) => s.match === chords.addCaption)
  if (!item) return null

  return (
    <div
      className={`pointer-events-none absolute right-0 top-1.5 flex ${lineH} animate-in items-center rounded-md bg-background pl-3 text-xs text-muted-foreground fade-in duration-150`}
    >
      <button
        type="button"
        // tabIndex=-1, как у значков строки: полотно — один Tab-stop (§3.1), а
        // клавиатурный эквивалент у кнопки свой и напечатан прямо на ней.
        tabIndex={-1}
        aria-label="Добавить заголовок вопроса"
        // Клик не должен уводить фокус со строки: без этого mousedown гасит активную
        // строку, чип размонтируется вместе с кнопкой, и mouseup приходит мимо цели —
        // клик молча теряется (тот же механизм, что TD-22).
        onMouseDown={(e) => e.preventDefault()}
        onClick={onAddCaption}
        className="pointer-events-auto flex items-center gap-1.5 whitespace-nowrap rounded hover:text-foreground"
      >
        <kbd className="rounded border border-border bg-muted px-1 py-px font-sans text-xs leading-4 text-foreground/70">
          {formatLabel(item.label)}
        </kbd>
        {item.short ?? item.hint}
      </button>
    </div>
  )
}
