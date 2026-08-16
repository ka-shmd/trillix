import { Copy, Plus, Trash2 } from 'lucide-react'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { useBuilderStore } from '../storeContext'
import { ConditionEditor } from './ConditionEditor'
import { RowMenu } from './rowMenu'
import {
  ACTION_LABELS,
  JUMP_END,
  asRootGroup,
  jumpTargetsFrom,
  logicBlockWarnings,
  optionTargets,
  requireTargets,
  showTargets,
  sourcesFor,
  targetLabel,
  valueChoices,
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
  const sources = sourcesFor(blocks, block.id)
  const warnings = logicBlockWarnings(blocks, block)

  const setWhen = (next: LogicCondition | undefined): void => {
    updateBlock(block.id, { logic: { when: next, then: actions.length ? actions : undefined } })
  }
  const setActions = (next: LogicAction[]): void => {
    updateBlock(block.id, { logic: { when, then: next.length ? next : undefined } })
  }

  return (
    <div className="flex flex-col gap-2 py-1 text-sm">
      <Tier label="Когда">
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
                    ? () => setActions(insertAfter(actions, i, defaultAction(blocks, block.id)))
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
            />
          )}
        </div>
      </Tier>

      {warnings.length > 0 && (
        <ul className="text-muted-foreground pl-16 text-xs">
          {warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Tier({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted-foreground w-14 shrink-0 text-xs tracking-wide uppercase">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground/60">{children}</span>
}

// Первое действие, которое имеет смысл предложить: «показать» ближайшую цель ниже. Без
// целей — «скрыть кнопку»: оно единственное, которому цель не нужна вовсе.
function defaultAction(blocks: readonly Block[], logicId: string): LogicAction {
  const target = showTargets(blocks, logicId)[0]
  return target ? { kind: 'show', target: target.id } : { kind: 'block_submit' }
}

const insertAfter = (list: LogicAction[], i: number, node: LogicAction): LogicAction[] => [
  ...list.slice(0, i + 1),
  node,
  ...list.slice(i + 1),
]

// Действие по виду и цели — или null, если цель нужна, а взять её неоткуда. Null значит
// «в документ ещё нечего писать»: пустая цель невалидна по схеме, и автосейв поймал бы
// на ней 422.
function buildAction(
  kind: LogicActionKind,
  targets: readonly Block[],
  keep?: string,
): LogicAction | null {
  if (kind === 'block_submit') return { kind }
  if (kind === 'jump') return { kind, end: true }
  const target = targets.some((b) => b.id === keep) ? keep : targets[0]?.id
  if (target === undefined) return null
  return kind === 'show_options' || kind === 'hide_options'
    ? { kind, target, options: [] }
    : { kind, target }
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
  menu?: { onAdd?: () => void; onRemove: () => void; onDuplicate?: () => void }
}) {
  // Вид, выбранный, но ещё не записанный в документ: так бывает, когда действию нужна
  // цель, а ниже блока её пока нет. Держать такое состояние в документе нельзя (пустая
  // цель невалидна), а терять выбор автора — грубо: строка показывает вид и ждёт цель.
  const [draftKind, setDraftKind] = useState<LogicActionKind | null>(null)
  const kind = value?.kind ?? draftKind
  const targets = kind ? targetsForKind(blocks, logicId, kind) : []
  const target = value && 'target' in value ? value.target : undefined

  // Смена вида роняет цель, если она новому виду не подходит: обязательным бывает
  // только отвечаемый блок, варианты — только у списка. Несовместимая пара сделала бы
  // действие инертным молча.
  const pickKind = (next: LogicActionKind): void => {
    const built = buildAction(next, targetsForKind(blocks, logicId, next), target)
    if (built === null) {
      setDraftKind(next)
      return
    }
    setDraftKind(null)
    onChange(built)
  }

  const pickTarget = (id: string): void => {
    if (!kind) return
    setDraftKind(null)
    onChange(
      kind === 'show_options' || kind === 'hide_options'
        ? { kind, target: id, options: [] }
        : { kind: kind as 'show' | 'hide' | 'require', target: id },
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={kind ?? ''} onValueChange={(k) => pickKind(k as LogicActionKind)}>
        <SelectTrigger size="sm" className="h-7 min-w-44" aria-label="Действие">
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

      {kind === 'jump' && value?.kind === 'jump' ? (
        <JumpTarget blocks={blocks} logicId={logicId} value={value} onChange={onChange} />
      ) : kind === undefined || kind === null || kind === 'block_submit' ? null : (
        <Select value={targets.some((b) => b.id === target) ? target : ''} onValueChange={pickTarget}>
          <SelectTrigger size="sm" className="h-7 min-w-36 flex-1" aria-label="Цель действия">
            <SelectValue placeholder={targets.length === 0 ? 'ниже нечего выбрать' : 'Цель…'} />
          </SelectTrigger>
          <SelectContent>
            {targets.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {targetLabel(blocks, b)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {menu && (
        <RowMenu
          label="Действия со строкой"
          items={[
            ...(menu.onAdd ? [{ icon: Plus, label: 'Добавить действие', onSelect: menu.onAdd }] : []),
            { icon: Trash2, label: 'Удалить', onSelect: menu.onRemove },
            ...(menu.onDuplicate
              ? [{ icon: Copy, label: 'Дублировать', onSelect: menu.onDuplicate }]
              : []),
          ]}
        />
      )}

      {(value?.kind === 'show_options' || value?.kind === 'hide_options') && (
        <OptionPicker blocks={blocks} value={value} onChange={onChange} />
      )}
    </div>
  )
}

function targetsForKind(
  blocks: readonly Block[],
  logicId: string,
  kind: LogicActionKind,
): Block[] {
  switch (kind) {
    case 'show':
    case 'hide':
      return showTargets(blocks, logicId)
    case 'require':
      return requireTargets(blocks, logicId)
    case 'show_options':
    case 'hide_options':
      return optionTargets(blocks, logicId)
    default:
      return []
  }
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

// Какие варианты цели затронуты. Тумблерами, а не вторым выпадающим списком: выбор
// здесь множественный, и список вариантов короткий по построению — он весь виден
// сразу, без раскрытия.
function OptionPicker({
  blocks,
  value,
  onChange,
}: {
  blocks: readonly Block[]
  value: { kind: 'show_options' | 'hide_options'; target: string; options: string[] }
  onChange: (next: LogicAction) => void
}) {
  const target = blocks.find((b) => b.id === value.target)
  const choices = target ? valueChoices(target) : []
  if (choices.length === 0) return null
  const toggle = (id: string): void => {
    const next = value.options.includes(id)
      ? value.options.filter((o) => o !== id)
      : [...value.options, id]
    onChange({ ...value, options: next })
  }
  return (
    <div className="flex w-full flex-wrap gap-1 pl-1">
      {choices.map((c) => {
        const on = value.options.includes(c.value)
        return (
          <Button
            key={c.value}
            type="button"
            variant={on ? 'secondary' : 'ghost'}
            size="sm"
            className="h-6 px-2 text-xs"
            aria-pressed={on}
            onClick={() => toggle(c.value)}
          >
            {c.label}
          </Button>
        )
      })}
    </div>
  )
}
