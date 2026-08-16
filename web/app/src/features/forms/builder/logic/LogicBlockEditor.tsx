import { Check, ChevronDown, ChevronRight, Copy, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import {
  type Block,
  type LogicAction,
  type LogicActionKind,
  LOGIC_ACTIONS,
  MAX_LOGIC_ACTIONS,
  type LogicCondition,
} from '@entities/formSchema'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { useBuilderStore } from '../storeContext'
import { ConditionEditor, JoinSelect } from './ConditionEditor'
import { RowMenu } from './rowMenu'
import {
  ACTION_LABELS,
  JUMP_END,
  asRootGroup,
  jumpTargetsFrom,
  logicBlockWarnings,
  logicSources,
  filterTargetTree,
  targetTree,
  type TargetNode,
} from './model'

// Строка блока условной логики на полотне: «Когда <условие> → Тогда <действия>».
// Правило правится ЗДЕСЬ и больше нигде — вход в логику один (ADR §10).
//
// Дерево условий рисует ТОТ ЖЕ ConditionEditor, что стоял в диалоге: он уже умеет
// группы И/ИЛИ и вложенность, и второй редактор того же дерева разъехался бы с первым
// на первой правке. Диалог как отдельная поверхность больше не нужен.
//
// ПОДПИСКА НА ВЕСЬ МАССИВ БЛОКОВ здесь неизбежна и осознанна: источники, цели и номера
// страниц — свойства документа целиком. Цена ограничена тем, что таких строк на полотне
// единицы (у каждого вопроса их не бывает), а не тем, что подписка дешёвая.
export function LogicBlockEditor({ block }: { block: Block }) {
  const blocks = useBuilderStore((s) => s.blocks)
  const updateBlock = useBuilderStore((s) => s.updateBlock)

  const when = block.logic?.when
  const actions = block.logic?.then ?? []
  const sources = logicSources(blocks)
  const warnings = logicBlockWarnings(blocks, block)

  const setWhen = (next: LogicCondition | undefined): void => {
    updateBlock(block.id, { logic: { when: next, then: actions.length ? actions : undefined } })
  }
  const setActions = (next: LogicAction[]): void => {
    updateBlock(block.id, { logic: { when, then: next.length ? next : undefined } })
  }

  return (
    // РЕЙЛ БЛОКА — ВСЕГДА ВИДЕН и рисуется ЗДЕСЬ, внутри строки, а не групповым рейлом
    // `GroupRow`. Два довода. Первый: групповой рейл принадлежит вопросу и появляется по
    // своим правилам, а этот — часть вида самого блока, и «правило целиком вот отсюда
    // досюда» должно читаться всегда, а не когда полотну вздумается. Второй: блок —
    // одиночка (`canShareRow: false`), группы у него нет вовсе, и вешать его вид на
    // чужую механику значило бы завести ей исключение.
    <div className="border-border flex flex-col gap-2 border-l-2 py-1 pl-3 text-sm">
      <Tier
        label="Когда"
        trailing={
          when !== undefined ? (
            <JoinSelect value={asRootGroup(when)} onChange={(next) => setWhen(next)} />
          ) : null
        }
      >
        {sources.length === 0 ? (
          <Note>выше блока нет ни одного вопроса — условие не о чем спросить</Note>
        ) : (
          <ConditionEditor
            blocks={blocks}
            sources={sources}
            value={asRootGroup(when ?? { all: [] })}
            onChange={(next) => {
              const children = 'all' in next ? next.all : next.any
              // Группа без условий невалидна по схеме, и «условия нет» — это именно
              // отсутствие ключа, а не пустая группа.
              setWhen(children.length === 0 ? undefined : next)
            }}
          />
        )}
      </Tier>

      <Tier label="Тогда">
        <div className="flex flex-col gap-1.5">
          {actions.map((action, i) => (
            <ActionRow
              key={i}
              blocks={blocks}
              logicId={block.id}
              value={action}
              onChange={(next) => setActions(actions.map((a, j) => (j === i ? next : a)))}
              menu={{
                // Больше лимита схемы пункт не показываем: 422 в автосейве от нажатия
                // собственной кнопки — худший способ узнать про лимит.
                onAdd:
                  actions.length < MAX_LOGIC_ACTIONS
                    ? () => setActions(insertAfter(actions, i, defaultAction(blocks)))
                    : undefined,
                onRemove: () => setActions(actions.filter((_, j) => j !== i)),
                onDuplicate:
                  actions.length < MAX_LOGIC_ACTIONS
                    ? () => setActions(insertAfter(actions, i, action))
                    : undefined,
              }}
            />
          ))}
          {/* Пустой список рисуется ОДНОЙ незаполненной строкой, а не кнопкой
              «добавить», — тем же приёмом, что пустое условие: сняв кнопку, автор
              иначе остался бы без входа. В документ действие попадает, когда собрано
              настолько, чтобы быть валидным (кинд плюс цель, если она нужна). */}
          {actions.length === 0 && (
            <ActionRow
              blocks={blocks}
              logicId={block.id}
              value={null}
              onChange={(next) => setActions([next])}
              // Меню есть и здесь: второе действие добавляется, пока первое ещё не
              // выбрано. Удалять и дублировать нечего — этих пунктов нет.
              menu={{ onAdd: () => setActions([defaultAction(blocks)]) }}
            />
          )}
        </div>
      </Tier>

      {warnings.length > 0 && (
        <ul className="text-muted-foreground text-xs">
          {warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Ширина контрола строки: фиксированная, а не «во всю оставшуюся» (решение владельца
// 2026-08-16). Растянутый на пол-полотна выпадающий список читается как поле ввода, а
// длинное имя вопроса всё равно не помещается целиком — его обрезает многоточие.
// `max-w-full` оставлен, чтобы на узком полотне контрол не выпирал за край.
//
// Многоточие в конце — тремя классами разом; почему именно тремя, разобрано в
// ConditionEditor (`TRUNCATE`): `block` перебивает флекс слота, иначе `text-overflow` не
// действует и текст режется посреди буквы, `min-w-0` разрешает флекс-элементу сжаться,
// `truncate` ставит саму обрезку.
const CONTROL =
  'h-7 w-52 max-w-full *:data-[slot=select-value]:block *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate'

// Ярус: подпись СВОЕЙ строкой, содержимое под ней и БЕЗ отступа (решение владельца
// 2026-08-16). Подпись колонкой слева съедала бы ширину у строки условий, а в ней три
// контрола, и на узком полотне они переносятся.
//
// `trailing` — то, что стоит в одной строке с подписью: у «Когда» это связка
// «все/любое». Она принадлежит ярусу, а не первой строке условий: связывает она их все.
function Tier({
  label,
  trailing,
  children,
}: {
  label: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs tracking-wide uppercase">{label}</span>
        {trailing}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground/60">{children}</span>
}

// Первое действие, которое имеет смысл предложить: «показать» ближайшую цель ниже. Без
// целей — «скрыть кнопку»: оно единственное, которому цель не нужна вовсе.
function defaultAction(blocks: readonly Block[]): LogicAction {
  const first = targetTree(blocks, 'show')[0]?.items[0]
  return first ? { kind: 'show', targets: [first.id] } : { kind: 'block_submit' }
}

const insertAfter = (list: LogicAction[], i: number, node: LogicAction): LogicAction[] => [
  ...list.slice(0, i + 1),
  node,
  ...list.slice(i + 1),
]

// Действие по виду и уже выбранным целям — или null, если цели нужны, а взять их
// неоткуда. Null значит «в документ ещё нечего писать»: пустой список целей невалиден по
// схеме, и автосейв поймал бы на нём 422.
function buildAction(
  kind: LogicActionKind,
  tree: { items: TargetNode[] }[],
  keep: readonly string[],
): LogicAction | null {
  if (kind === 'block_submit') return { kind }
  if (kind === 'jump') return { kind, end: true }
  const known = new Set(tree.flatMap((p) => p.items.flatMap((n) => [n.id, ...n.children.map((c) => c.id)])))
  const kept = keep.filter((id) => known.has(id))
  const targets = kept.length > 0 ? kept : [tree[0]?.items[0]?.id].filter((id): id is string => Boolean(id))
  return targets.length > 0 ? { kind, targets } : null
}

function ActionRow({
  blocks,
  logicId,
  value,
  onChange,
  menu,
}: {
  blocks: readonly Block[]
  logicId: string
  // null — незаполненная строка: вид действия ещё не выбран.
  value: LogicAction | null
  onChange: (next: LogicAction) => void
  // Пункты по отдельности необязательны: у незаполненной строки нечего удалять и
  // дублировать, у полного списка нечего добавлять.
  menu?: { onAdd?: () => void; onRemove?: () => void; onDuplicate?: () => void }
}) {
  // Вид, выбранный, но ещё не записанный в документ: так бывает, когда действию нужны
  // цели, а в форме их пока нет. Держать такое состояние в документе нельзя (пустой
  // список целей невалиден), а терять выбор автора — грубо: строка показывает вид и
  // ждёт цель.
  const [draftKind, setDraftKind] = useState<LogicActionKind | null>(null)
  const kind = value?.kind ?? draftKind
  const picks = value && 'targets' in value ? value.targets : []
  const tree =
    kind === 'show' || kind === 'hide' || kind === 'require' ? targetTree(blocks, kind) : []

  // Смена вида роняет цели, которые новому виду не подходят: обязательным бывает только
  // отвечаемый блок, вариант — нет. Несовместимая пара сделала бы действие инертным
  // молча.
  const pickKind = (next: LogicActionKind): void => {
    const nextTree =
      next === 'show' || next === 'hide' || next === 'require' ? targetTree(blocks, next) : []
    const built = buildAction(next, nextTree, picks)
    if (built === null) {
      setDraftKind(next)
      return
    }
    setDraftKind(null)
    onChange(built)
  }

  const toggleTarget = (id: string): void => {
    if (kind !== 'show' && kind !== 'hide' && kind !== 'require') return
    const next = picks.includes(id) ? picks.filter((x) => x !== id) : [...picks, id]
    // Последняя снятая галка не пишется пустым списком — схема его отвергает; действие
    // остаётся с прежними целями до следующего выбора.
    if (next.length === 0) return
    setDraftKind(null)
    onChange({ kind, targets: next })
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={kind ?? ''} onValueChange={(k) => pickKind(k as LogicActionKind)}>
        <SelectTrigger size="sm" className={CONTROL} aria-label="Действие">
          <SelectValue placeholder="Выберите действие" />
        </SelectTrigger>
        <SelectContent>
          {LOGIC_ACTIONS.map((k) => (
            <SelectItem key={k} value={k}>
              {ACTION_LABELS[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Второй контрол стоит ВСЕГДА, даже когда действие ещё не выбрано: строка не
          должна перестраиваться под курсором, пока автор её заполняет. Исключение одно —
          «скрыть кнопку»: цели у неё нет не «пока», а вовсе. */}
      {kind === 'jump' && value?.kind === 'jump' ? (
        <JumpTarget blocks={blocks} logicId={logicId} value={value} onChange={onChange} />
      ) : kind === 'block_submit' ? null : (
        <TargetPicker tree={tree} picks={picks} onToggle={toggleTarget} disabled={kind === null} />
      )}

      {menu && (
        <RowMenu
          label="Действия со строкой"
          items={[
            ...(menu.onAdd
              ? [{ icon: Plus, label: 'Добавить действие', onSelect: menu.onAdd }]
              : []),
            ...(menu.onRemove ? [{ icon: Trash2, label: 'Удалить', onSelect: menu.onRemove }] : []),
            ...(menu.onDuplicate
              ? [{ icon: Copy, label: 'Дублировать', onSelect: menu.onDuplicate }]
              : []),
          ]}
        />
      )}

    </div>
  )
}

// Цель перехода — одно поле выбора, хотя в схеме это две формы (id разрыва или флаг
// end). Разворачивает обратно здесь: строка-маркер JUMP_END в документ не уезжает.
function JumpTarget({
  blocks,
  logicId,
  value,
  onChange,
}: {
  blocks: readonly Block[]
  logicId: string
  value: { kind: 'jump'; to?: string; end?: boolean }
  onChange: (next: LogicAction) => void
}) {
  const targets = jumpTargetsFrom(blocks, logicId)
  const current = value.end === true ? JUMP_END : (value.to ?? '')
  return (
    <Select
      value={targets.some((t) => t.value === current) ? current : ''}
      onValueChange={(v) => onChange(v === JUMP_END ? { kind: 'jump', end: true } : { kind: 'jump', to: v })}
    >
      <SelectTrigger size="sm" className="h-7 min-w-36 flex-1" aria-label="Куда перейти">
        <SelectValue placeholder="Страница…" />
      </SelectTrigger>
      <SelectContent>
        {targets.map((t) => (
          <SelectItem key={t.value} value={t.value}>
            {t.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// Пикер целей — ДЕРЕВО: страница → вопрос → его варианты (образец — Tally). Узлы
// раскрываются и сворачиваются шевроном, вложенность держат рейлы.
//
// Дерево, а не плоский список, потому что вариант выбора — такая же цель, что и вопрос:
// отдельного действия «скрыть варианты» нет, и в одном пикере лежат оба уровня.
// Множественный выбор — потому что «скрыть эту ветку» это обычно несколько блоков сразу.
//
// УМОЛЧАНИЕ: страницы раскрыты, варианты свёрнуты (решение владельца 2026-08-16). Автор
// почти всегда ищет вопрос, а не вариант, и развёрнутые списки вариантов отодвигали бы
// вопросы за нижний край.
//
// ФИЛЬТРУЕМ САМИ (`shouldFilter={false}`), а не отдаём cmdk: свёрнутый узел не
// отрисован, и его дети для чужого фильтра не существуют — поиск молча не находил бы
// половину документа. Поэтому при непустом запросе дерево раскрывается целиком, а
// совпадение ищется и по вариантам.
function TargetPicker({
  tree,
  picks,
  onToggle,
  disabled = false,
}: {
  tree: { page: number; items: TargetNode[] }[]
  picks: readonly string[]
  onToggle: (id: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [closedPages, setClosedPages] = useState<ReadonlySet<number>>(new Set())
  const [openNodes, setOpenNodes] = useState<ReadonlySet<string>>(new Set())

  const names = new Map<string, string>()
  for (const { items } of tree) {
    for (const n of items) {
      names.set(n.id, n.label)
      for (const c of n.children) names.set(c.id, c.label)
    }
  }
  const chosen = picks.filter((id) => names.has(id))
  const summary =
    chosen.length === 0
      ? disabled || names.size === 0
        ? 'Блоки'
        : 'Выберите блоки'
      : chosen.length === 1
        ? names.get(chosen[0]!)!
        : `Выбрано: ${chosen.length}`

  const found = filterTargetTree(tree, query)
  const searching = query.trim() !== ''

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="Цели действия"
          disabled={disabled}
          className={`${CONTROL} justify-between font-normal`}
        >
          <span className="min-w-0 truncate">{summary}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Поиск" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-80">
            {found.length === 0 ? (
              <div className="text-muted-foreground py-6 text-center text-sm">Ничего не найдено</div>
            ) : (
              found.map(({ page, items }) => {
                const pageOpen = searching || !closedPages.has(page)
                return (
                  <div key={page} className="px-1 py-1">
                    <TreeRow
                      chevron={pageOpen}
                      onChevron={() => setClosedPages(toggled(closedPages, page))}
                      label={`Страница ${page}`}
                      muted
                    />
                    {pageOpen && (
                      <Rail>
                        {items.map((node) => {
                          const nodeOpen = searching || openNodes.has(node.id)
                          return (
                            <div key={node.id}>
                              <TreeRow
                                chevron={node.children.length > 0 ? nodeOpen : undefined}
                                onChevron={() => setOpenNodes(toggled(openNodes, node.id))}
                                label={node.label}
                                checked={picks.includes(node.id)}
                                onSelect={() => onToggle(node.id)}
                              />
                              {nodeOpen && node.children.length > 0 && (
                                <Rail>
                                  {node.children.map((c) => (
                                    <TreeRow
                                      key={c.id}
                                      label={c.label}
                                      checked={picks.includes(c.id)}
                                      onSelect={() => onToggle(c.id)}
                                    />
                                  ))}
                                </Rail>
                              )}
                            </div>
                          )
                        })}
                      </Rail>
                    )}
                  </div>
                )
              })
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const toggled = <T,>(set: ReadonlySet<T>, key: T): ReadonlySet<T> => {
  const next = new Set(set)
  if (!next.delete(key)) next.add(key)
  return next
}

// Ветка дерева: отступ плюс вертикальный рейл, тот самый, что держит вложенность на глаз.
function Rail({ children }: { children: React.ReactNode }) {
  return <div className="border-border ml-[13px] border-l pl-2">{children}</div>
}

// Строка дерева. Три роли в одной: заголовок страницы (muted, без галки), вопрос и
// вариант. Шеврон — СВОЯ кнопка: клик по нему раскрывает узел, клик по строке отмечает
// цель, и путать эти два жеста нельзя.
function TreeRow({
  chevron,
  onChevron,
  label,
  checked,
  onSelect,
  muted = false,
}: {
  chevron?: boolean
  onChevron?: () => void
  label: string
  checked?: boolean
  onSelect?: () => void
  muted?: boolean
}) {
  const body = (
    <>
      {chevron === undefined ? (
        <span className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <button
          type="button"
          aria-label={chevron ? `Свернуть «${label}»` : `Раскрыть «${label}»`}
          className="hover:bg-muted flex size-4 shrink-0 items-center justify-center rounded-sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onChevron?.()
          }}
        >
          {chevron ? (
            <ChevronDown className="size-3.5 opacity-60" />
          ) : (
            <ChevronRight className="size-3.5 opacity-60" />
          )}
        </button>
      )}
      {checked !== undefined && (
        <span
          className={`flex size-4 shrink-0 items-center justify-center rounded-sm border ${
            checked ? 'bg-primary border-primary text-primary-foreground' : 'border-input'
          }`}
          aria-hidden="true"
        >
          {checked && <Check className="size-3" />}
        </span>
      )}
      <span className={`truncate ${muted ? 'text-muted-foreground text-xs' : ''}`}>{label}</span>
    </>
  )

  // Заголовок страницы целью не бывает: страница — не блок, и адресовать её действию
  // нечем. Поэтому он не CommandItem — по нему не ходит клавиатура выбора.
  if (onSelect === undefined) {
    return <div className="flex items-center gap-2 px-2 py-1.5">{body}</div>
  }
  return (
    <CommandItem value={label} onSelect={onSelect} className="gap-2">
      {body}
    </CommandItem>
  )
}
