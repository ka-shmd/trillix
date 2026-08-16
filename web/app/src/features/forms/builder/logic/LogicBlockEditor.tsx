import { Plus, X } from 'lucide-react'

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
              onRemove={() => setActions(actions.filter((_, j) => j !== i))}
            />
          ))}
          {actions.length === 0 && <Note>действие не выбрано — блок ничего не делает</Note>}
          {/* Больше лимита схемы кнопку не показываем: 422 в автосейве от нажатия
              собственной кнопки — худший способ узнать про лимит. */}
          {actions.length < MAX_LOGIC_ACTIONS && (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => setActions([...actions, defaultAction(blocks, block.id)])}
              >
                <Plus className="size-3.5" />
                Действие
              </Button>
            </div>
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

function ActionRow({
  blocks,
  logicId,
  value,
  onChange,
  onRemove,
}: {
  blocks: readonly Block[]
  logicId: string
  value: LogicAction
  onChange: (next: LogicAction) => void
  onRemove: () => void
}) {
  const targets = targetsForKind(blocks, logicId, value.kind)

  // Смена действия роняет цель, если она новому действию не подходит: обязательным
  // бывает только отвечаемый блок, варианты — только у списка. Несовместимая пара
  // сделала бы действие инертным молча.
  const pickKind = (kind: LogicActionKind): void => {
    if (kind === 'block_submit') {
      onChange({ kind })
      return
    }
    if (kind === 'jump') {
      onChange({ kind, end: true })
      return
    }
    const keep =
      'target' in value && targetsForKind(blocks, logicId, kind).some((b) => b.id === value.target)
    const target = keep && 'target' in value ? value.target : targetsForKind(blocks, logicId, kind)[0]?.id
    if (target === undefined) return
    onChange(
      kind === 'show_options' || kind === 'hide_options'
        ? { kind, target, options: [] }
        : { kind, target },
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={value.kind} onValueChange={(k) => pickKind(k as LogicActionKind)}>
        <SelectTrigger size="sm" className="h-7 min-w-44" aria-label="Действие">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LOGIC_ACTIONS.map((kind) => (
            <SelectItem key={kind} value={kind}>
              {ACTION_LABELS[kind]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {value.kind === 'jump' ? (
        <JumpTarget blocks={blocks} logicId={logicId} value={value} onChange={onChange} />
      ) : value.kind === 'block_submit' ? null : (
        <Select
          value={targets.some((b) => b.id === value.target) ? value.target : ''}
          onValueChange={(id) =>
            onChange(
              value.kind === 'show_options' || value.kind === 'hide_options'
                ? { kind: value.kind, target: id, options: [] }
                : { kind: value.kind, target: id },
            )
          }
        >
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

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Удалить действие"
        onClick={onRemove}
      >
        <X className="size-4" />
      </Button>

      {(value.kind === 'show_options' || value.kind === 'hide_options') && (
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
