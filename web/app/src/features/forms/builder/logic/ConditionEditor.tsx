import { Plus, X } from 'lucide-react'

import {
  type Block,
  type LogicCondition,
  type LogicOperator,
  MAX_LOGIC_DEPTH,
  opNeedsValue,
} from '@entities/formSchema'
import { operatorsFor } from '@fields/logic'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { type Group, OPERATOR_LABELS, defaultLeaf, sourceLabel, valueChoices } from './model'

// Редактор дерева условий (фаза 21). Рекурсивный: группа рисует своих детей тем же
// компонентом, поэтому вложенность «(А и Б) или В» не стоит ни одной особой ветки.
//
// Инвариант формы, который держит редактор: КОРЕНЬ ВСЕГДА ГРУППА. Схема принимает и
// одинокий лист, но два способа выразить одно правило означали бы две ветки в каждой
// операции редактора («а если корень лист — сперва заверни»). Группа из одного условия
// валидна и выглядит ровно как одно условие.

const childrenOf = (g: Group): LogicCondition[] => ('all' in g ? g.all : g.any)
const isAnd = (g: Group): boolean => 'all' in g
const asGroup = (children: LogicCondition[], and: boolean): Group =>
  and ? { all: children } : { any: children }

export function ConditionEditor({
  blocks,
  sources,
  value,
  depth = 1,
  onChange,
  onRemove,
}: {
  blocks: readonly Block[]
  // Источники — отвечаемые вопросы выше носителя (sourcesFor). Считаются один раз
  // наверху и раздаются вниз: список одинаков для всего дерева.
  sources: readonly Block[]
  value: Group
  depth?: number
  onChange: (next: Group) => void
  onRemove?: () => void
}) {
  const children = childrenOf(value)
  const and = isAnd(value)

  const replaceChild = (i: number, next: LogicCondition | null): void => {
    const rest = children.filter((_, j) => j !== i)
    if (next === null) {
      // Группа без условий невалидна по схеме, и это не формальность: правило,
      // которое ничего не проверяет, неотличимо от отсутствующего. Пустую группу
      // редактор просто убирает целиком.
      if (rest.length === 0) {
        onRemove?.()
        return
      }
      onChange(asGroup(rest, and))
      return
    }
    onChange(asGroup(children.map((c, j) => (j === i ? next : c)), and))
  }

  const addLeaf = (): void => {
    const source = sources[0]
    if (!source) return
    onChange(asGroup([...children, defaultLeaf(source)], and))
  }

  const addGroup = (): void => {
    const source = sources[0]
    if (!source) return
    onChange(asGroup([...children, { all: [defaultLeaf(source)] }], and))
  }

  return (
    <div className={depth > 1 ? 'border-muted space-y-2 rounded-md border-l-2 py-2 pl-3' : 'space-y-2'}>
      <div className="flex items-center gap-2">
        <Select
          value={and ? 'all' : 'any'}
          onValueChange={(v) => onChange(asGroup(children, v === 'all'))}
        >
          <SelectTrigger size="sm" className="h-7 w-40" aria-label="Как объединять условия">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все условия</SelectItem>
            <SelectItem value="any">Любое из условий</SelectItem>
          </SelectContent>
        </Select>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Удалить группу условий"
            onClick={onRemove}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      {children.map((child, i) => {
        const key = `${i}`
        if ('all' in child || 'any' in child) {
          return (
            <ConditionEditor
              key={key}
              blocks={blocks}
              sources={sources}
              value={child}
              depth={depth + 1}
              onChange={(next) => replaceChild(i, next)}
              onRemove={() => replaceChild(i, null)}
            />
          )
        }
        return (
          <LeafRow
            key={key}
            blocks={blocks}
            sources={sources}
            value={child}
            onChange={(next) => replaceChild(i, next)}
            onRemove={() => replaceChild(i, null)}
          />
        )
      })}

      <div className="flex gap-2">
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={addLeaf}>
          <Plus className="size-3.5" />
          Условие
        </Button>
        {/* Глубже лимита схемы кнопку не показываем: 422 в автосейве от нажатия
            собственной кнопки — худший способ узнать про лимит. */}
        {depth < MAX_LOGIC_DEPTH && (
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={addGroup}>
            <Plus className="size-3.5" />
            Группа
          </Button>
        )}
      </div>
    </div>
  )
}

// Лист: «вопрос — сравнение — значение». Значение показывается только у операторов,
// которые сравнивают (у «отвечен» его нет вовсе).
function LeafRow({
  blocks,
  sources,
  value,
  onChange,
  onRemove,
}: {
  blocks: readonly Block[]
  sources: readonly Block[]
  value: { blockId: string; op: LogicOperator; value?: string }
  onChange: (next: LogicCondition) => void
  onRemove: () => void
}) {
  const source = blocks.find((b) => b.id === value.blockId)
  const ops = source ? operatorsFor(source.type) : []
  const choices = source ? valueChoices(source) : []
  const needsValue = opNeedsValue(value.op)

  // Смена источника роняет оператор и значение, если они ему не подходят: id варианта
  // от прошлого списка в новом не значит ничего, а несовместимый оператор сделал бы
  // правило инертным молча.
  const pickSource = (id: string): void => {
    const next = blocks.find((b) => b.id === id)
    if (!next) return
    onChange(operatorsFor(next.type).includes(value.op) ? { ...defaultLeaf(next), op: value.op } : defaultLeaf(next))
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={source ? value.blockId : ''} onValueChange={pickSource}>
        <SelectTrigger size="sm" className="h-7 min-w-40 flex-1" aria-label="Вопрос-источник">
          <SelectValue placeholder="Удалённый вопрос" />
        </SelectTrigger>
        <SelectContent>
          {sources.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {sourceLabel(blocks, b)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={value.op}
        onValueChange={(op) =>
          onChange({
            blockId: value.blockId,
            op: op as LogicOperator,
            // «отвечен»/«не отвечен» значения не несут — схема непустое value у них
            // отвергает, поэтому роняем его здесь, а не ловим 422 автосейвом.
            ...(opNeedsValue(op as LogicOperator) && value.value ? { value: value.value } : {}),
          })
        }
      >
        <SelectTrigger size="sm" className="h-7 w-36" aria-label="Сравнение">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {needsValue &&
        (choices.length > 0 ? (
          <Select
            value={value.value ?? ''}
            onValueChange={(v) => onChange({ ...value, value: v })}
          >
            <SelectTrigger size="sm" className="h-7 min-w-32 flex-1" aria-label="Значение">
              <SelectValue placeholder="Значение…" />
            </SelectTrigger>
            <SelectContent>
              {choices.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            className="h-7 min-w-32 flex-1 text-sm"
            value={value.value ?? ''}
            placeholder="Значение…"
            aria-label="Значение"
            onChange={(e) =>
              onChange(
                e.target.value === ''
                  ? { blockId: value.blockId, op: value.op }
                  : { ...value, value: e.target.value },
              )
            }
          />
        ))}

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Удалить условие"
        onClick={onRemove}
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}
