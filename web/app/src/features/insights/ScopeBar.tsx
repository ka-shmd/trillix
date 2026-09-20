import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, Plus, SlidersHorizontal, X } from 'lucide-react'
import { useState } from 'react'

import { versionStatsQueryOptions, visitsBreakdownQueryOptions } from './queries'
import { segmentOptions, segmentValueLabel, type SegmentOption } from './segment'
import { type BlockSummary } from '../../entities/summary'
import { type LogicOperator } from '@entities/formSchema'
import { operatorsFor } from '@fields/logic'
import {
  decodeFilter,
  equalsOp,
  MAX_FILTER_CONDITIONS,
  needsValue,
  withCondition,
  type FilterCondition,
} from '../../shared/answerFilter'
import { BlockTypeIcon } from '../../shared/BlockTypeIcon'
import { operatorLabel } from '../../shared/logicLabels'
import { type Period } from '../../shared/period'
import {
  MAX_SEGMENTS,
  segmentDimLabels,
  splitSegment,
  withSegment,
  type SegmentDim,
} from '../../shared/segment'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// Выборка экрана аналитики: кого считать. Один контрол на «Обзоре» и «Ответах»
// (решение владельца 2026-09-20: «контролы неудобные и неинтуитивные — и в логике
// тоже»).
//
// Устройство контрола держат три правила.
//
// ПЕРВОЕ: НА ЭКРАНЕ ВИДНО ПРИМЕНЁННОЕ, А НЕ СРЕДСТВА ЕГО ПРИМЕНИТЬ. Применённое —
// чипсы, каждый со своим крестиком; добавление — одна кнопка. Пока выборка пуста,
// от контрола на экране одна строка.
//
// ВТОРОЕ: ОДИН СПИСОК ПОЛЕЙ, А НЕ ДВА КОНТРОЛА. «Кто пришёл» (свойство визита) и
// «Что ответил» (ответ на вопрос) — разные множества (docs/ANALYTICS.md §1) и едут
// в запросе разными параметрами (`segment` и `where`), но человек выбирает одно и
// то же: по какому признаку сузить. Разные параметры — забота этого файла, а не
// повод показывать два органа управления.
//
// Условий и с той, и с другой стороны бывает НЕСКОЛЬКО, и складываются они через
// «И» — «телефоны из vk.com, выбравшие Pro». На измерение и на пару «вопрос +
// оператор» условие при этом одно: второе значение заменяет первое, потому что
// «устройство — телефон И устройство — планшет» не сужает выборку, а обнуляет её.
//
// ТРЕТЬЕ: ШАГИ ИДУТ ОДИН ЗА ДРУГИМ В ОДНОМ ОКНЕ. Поле → значение, и для закрытого
// вопроса и визитного измерения это ВСЁ: оператор там подразумевается равенством.
// Окна в окне не бывает: поповер выборки, открывающий второй поповер с тремя
// выпадающими списками подряд (вопрос, оператор, значение), делает простейший
// разрез «телефоны» в пять нажатий.
//
// В списке значений стоят ЧИСЛА: разрез выбирают по величине, и «Телефон 2751»
// отвечает на вопрос «а есть ли там кто-нибудь» до применения, а не после.
export function ScopeBar({
  formId,
  period,
  segments,
  where,
  blocks = [],
  onSegments,
  onWhere,
}: {
  formId: string
  period: Period
  segments: string[]
  where?: string
  // Вопросы для условий по ответам — из сводки БЕЗ выборки: при пустом результате
  // или закрытом тарифе отфильтрованной сводки нет, а менять условия всё равно
  // нужно. Пусто (и нет onWhere) — экран условий по ответам не принимает: воронку
  // «Обзора» сервер по ответам не режет.
  blocks?: BlockSummary[]
  onSegments: (next: string[]) => void
  onWhere?: (next: FilterCondition[]) => void
}) {
  const conditions = onWhere ? decodeFilter(where) : []
  const applied = segments.length + conditions.length
  const byId = new Map(blocks.map((b) => [b.blockId, b]))

  return (
    <div className="flex flex-wrap items-center gap-2">
      {segments.map((raw) => {
        const seg = splitSegment(raw)
        return (
          seg && (
            <Chip
              key={raw}
              text={`${segmentDimLabels[seg.dim]}: ${segmentValueLabel(seg.dim, seg.value)}`}
              onRemove={() => onSegments(segments.filter((s) => s !== raw))}
            />
          )
        )
      })}
      {conditions.map((c, i) => (
        <Chip
          key={`${c.blockId}-${i}`}
          text={conditionText(c, byId.get(c.blockId))}
          onRemove={() => onWhere?.(conditions.filter((_, j) => j !== i))}
        />
      ))}

      <ScopePicker
        formId={formId}
        period={period}
        empty={applied === 0}
        // Условий по ответам не больше, чем принимает сервер
        // (domain.MaxFilterConditions); достигли потолка — вопросов в списке полей
        // нет, а измерения визита остаются.
        blocks={conditions.length < MAX_FILTER_CONDITIONS && onWhere ? blocks : []}
        // Измерение, по которому условие уже стоит, из списка полей не убирается:
        // выбор другого значения того же измерения — обычное дело («не телефоны, а
        // планшеты»), и он заменит условие, а не добавит второе. Убирать нечего
        // только когда условий уже столько, сколько принимает сервер.
        dims={segments.length >= MAX_SEGMENTS ? appliedDims(segments) : undefined}
        onSegment={(dim, value) => onSegments(withSegment(segments, dim, value))}
        onCondition={(c) => onWhere?.(withCondition(conditions, c))}
      />

      {/* Сброс — только когда сбрасывать есть что И крестиков больше одного:
          у единственного чипса его собственный крестик делает ровно то же. */}
      {applied > 1 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onSegments([])
            onWhere?.([])
          }}
        >
          Сбросить всё
        </Button>
      )}
    </div>
  )
}

function Chip({ text, onRemove }: { text: string; onRemove: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted py-1 pr-1 pl-2.5 text-sm">
      <span className="min-w-0 truncate">{text}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label={`Убрать «${text}»`}
        onClick={onRemove}
      >
        <X className="size-3.5" />
      </Button>
    </span>
  )
}

function conditionText(c: FilterCondition, block: BlockSummary | undefined): string {
  if (!block) return 'Вопрос удалён'
  const op = operatorLabel(c.op, block.type)
  if (!needsValue(c.op) || c.value === undefined) return `${block.label} — ${op}`
  const option = block.buckets.find((b) => b.key === c.value)
  return `${block.label} — ${op} «${option?.label ?? c.value}»`
}

// Шаги окна. Значение и оператор — разные шаги, а не разные контролы на одном
// экране: у закрытого вопроса шага «оператор» не бывает вовсе.
type Stage = 'field' | 'value' | 'op' | 'text'

type Field = { kind: 'visit'; dim: SegmentDim } | { kind: 'answer'; block: BlockSummary }

// appliedDims — измерения, по которым условие уже стоит. На потолке условий список
// полей сжимается до них: новое измерение добавить нельзя, а поменять значение уже
// выбранного — можно.
function appliedDims(segments: string[]): SegmentDim[] {
  return segments.flatMap((raw) => {
    const seg = splitSegment(raw)
    return seg ? [seg.dim] : []
  })
}

function ScopePicker({
  formId,
  period,
  empty,
  blocks,
  dims,
  onSegment,
  onCondition,
}: {
  formId: string
  period: Period
  empty: boolean
  blocks: BlockSummary[]
  // Какие измерения показывать; undefined — все.
  dims?: SegmentDim[]
  onSegment: (dim: SegmentDim, value: string) => void
  onCondition: (c: FilterCondition) => void
}) {
  const [open, setOpen] = useState(false)
  const [stage, setStage] = useState<Stage>('field')
  const [field, setField] = useState<Field | null>(null)
  const [op, setOp] = useState<LogicOperator | null>(null)
  const [text, setText] = useState('')
  // Поиск управляемый, потому что его надо ГАСИТЬ на каждом шаге: cmdk держит
  // строку в своём состоянии, и набранное на шаге поля осталось бы фильтровать
  // список значений — «Устр» не встречается ни в одном устройстве, и шаг второй
  // открывался бы словами «Ничего не найдено».
  const [query, setQuery] = useState('')

  // Разбивка нужна ДО выбора измерения: по ней список полей знает, у каких
  // измерений за это окно вообще есть значения. Измерение без значений — тупик:
  // выбрал «Страну», а выбирать не из чего. Запрос тот же, что у вкладки «Визиты»,
  // и в пределах минуты берётся из кеша.
  const breakdown = useQuery({ ...visitsBreakdownQueryOptions(formId, period), enabled: open })
  const versions = useQuery({ ...versionStatsQueryOptions(formId, period), enabled: open })

  const reset = () => {
    setStage('field')
    setField(null)
    setOp(null)
    setText('')
    setQuery('')
  }
  const close = () => {
    setOpen(false)
    reset()
  }

  const pickField = (next: Field) => {
    setField(next)
    setQuery('')
    if (next.kind === 'visit') {
      setStage('value')
      return
    }
    // Закрытый вопрос выбирается значением: «равен» у него единственный
    // осмысленный оператор, и спрашивать о нём значит спрашивать ни о чём.
    setStage(next.block.kind === 'distribution' && next.block.buckets.length > 0 ? 'value' : 'op')
  }

  const pickOp = (next: LogicOperator) => {
    setOp(next)
    setQuery('')
    if (needsValue(next)) {
      setStage('text')
      return
    }
    if (field?.kind === 'answer') {
      onCondition({ blockId: field.block.blockId, op: next })
      close()
    }
  }

  const options: SegmentOption[] =
    field?.kind === 'visit' ? segmentOptions(field.dim, breakdown.data, versions.data) : []
  const loading = breakdown.isPending || versions.isPending

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <PopoverTrigger asChild>
        {/* Пока не выбрано ничего — «Фильтр» (решение владельца 2026-09-20). Когда
            чипсы уже стоят, они и говорят, что применено, и кнопка сжимается до
            добавления следующего условия. */}
        <Button variant={empty ? 'outline' : 'ghost'} size="sm">
          {empty ? <SlidersHorizontal className="size-4" /> : <Plus className="size-4" />}
          {empty ? 'Фильтр' : 'Ещё условие'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        {field && (
          // Возврат — первой строкой окна: шаг второй показывает значения одного
          // поля, и без пути назад ошибка в поле стоила бы закрытия окна.
          <div className="flex items-center gap-1 border-b p-1">
            <Button variant="ghost" size="icon" className="size-7" aria-label="Назад" onClick={reset}>
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-0 truncate text-sm font-medium">{fieldLabel(field)}</span>
          </div>
        )}

        {stage === 'text' && field?.kind === 'answer' && op !== null ? (
          <ValueInput
            block={field.block}
            op={op}
            value={text}
            onChange={setText}
            onSubmit={() => {
              const trimmed = text.trim()
              if (trimmed === '') return
              onCondition({ blockId: field.block.blockId, op, value: trimmed })
              close()
            }}
          />
        ) : (
          <Command>
            <CommandInput
              placeholder={stage === 'field' ? 'Поиск поля' : 'Поиск'}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList className="max-h-72">
              <CommandEmpty>Ничего не найдено</CommandEmpty>

              {stage === 'field' && (
                <>
                  <CommandGroup heading="Кто пришёл">
                    {(dims ?? (Object.keys(segmentDimLabels) as SegmentDim[]))
                      // Измерение без значений за окно в списке не стоит: оно ведёт
                      // в пустой список и выглядит поломкой справочника.
                      .filter(
                        (dim) =>
                          loading || segmentOptions(dim, breakdown.data, versions.data).length > 0,
                      )
                      .map((dim) => (
                        <CommandItem key={dim} onSelect={() => pickField({ kind: 'visit', dim })}>
                          {segmentDimLabels[dim]}
                        </CommandItem>
                      ))}
                  </CommandGroup>
                  {blocks.length > 0 && (
                    <CommandGroup heading="Что ответил">
                      {blocks
                        .filter((b) => operatorsFor(b.type).length > 0)
                        .map((b) => (
                          <CommandItem
                            key={b.blockId}
                            value={b.label}
                            onSelect={() => pickField({ kind: 'answer', block: b })}
                          >
                            <BlockTypeIcon type={b.type} className="text-muted-foreground" />
                            <span className="min-w-0 truncate">{b.label}</span>
                          </CommandItem>
                        ))}
                    </CommandGroup>
                  )}
                </>
              )}

              {stage === 'value' && field?.kind === 'visit' && (
                <CommandGroup>
                  {loading && <CommandItem disabled>Загрузка…</CommandItem>}
                  {options.map((o) => (
                    <Choice
                      key={o.value}
                      // Значение города — внутренний ключ «КОД:Имя»; искать по нему
                      // человек не станет, поэтому в фильтр cmdk едет подпись.
                      search={o.label}
                      label={o.label}
                      count={o.count}
                      onSelect={() => {
                        onSegment(field.dim, o.value)
                        close()
                      }}
                    />
                  ))}
                </CommandGroup>
              )}

              {stage === 'value' && field?.kind === 'answer' && (
                <>
                  <CommandGroup>
                    {field.block.buckets.map((b) => (
                      <Choice
                        key={b.key}
                        search={b.label}
                        label={b.label}
                        count={b.count}
                        onSelect={() => {
                          onCondition({
                            blockId: field.block.blockId,
                            op: equalsOp(field.block.type),
                            value: b.key,
                          })
                          close()
                        }}
                      />
                    ))}
                  </CommandGroup>
                  {/* Сравнения («оценка больше 8», «не отвечен») не пропадают из-за
                      того, что у закрытого вопроса короткий путь — они за одной
                      строкой, а не на месте короткого пути. */}
                  <CommandGroup>
                    <CommandItem
                      onSelect={() => {
                        setStage('op')
                        setQuery('')
                      }}
                    >
                      Другое условие…
                    </CommandItem>
                  </CommandGroup>
                </>
              )}

              {stage === 'op' && field?.kind === 'answer' && (
                <CommandGroup>
                  {operatorsFor(field.block.type).map((o) => (
                    <CommandItem
                      key={o}
                      value={operatorLabel(o, field.block.type)}
                      onSelect={() => pickOp(o)}
                    >
                      {operatorLabel(o, field.block.type)}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}

// Строка выбора со своей величиной. Число прижато к правому краю и серое: это
// справка о размере, а не то, что выбирают.
function Choice({
  search,
  label,
  count,
  onSelect,
}: {
  search: string
  label: string
  count?: number
  onSelect: () => void
}) {
  return (
    <CommandItem value={search} onSelect={onSelect}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
      )}
    </CommandItem>
  )
}

function ValueInput({
  block,
  op,
  value,
  onChange,
  onSubmit,
}: {
  block: BlockSummary
  op: LogicOperator
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
}) {
  return (
    <form
      className="flex flex-col gap-3 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <p className="text-sm text-muted-foreground">{operatorLabel(op, block.type)}</p>
      <Input
        autoFocus
        aria-label="Значение"
        type={block.type === 'number' ? 'number' : block.type === 'date' ? 'date' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={value.trim() === ''}>
        Добавить
      </Button>
    </form>
  )
}

function fieldLabel(field: Field): string {
  return field.kind === 'visit' ? segmentDimLabels[field.dim] : field.block.label
}
