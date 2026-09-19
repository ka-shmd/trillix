import { Plus, X } from 'lucide-react'
import { useState } from 'react'

import { type BlockSummary } from '../../entities/summary'
import { operatorsFor } from '@fields/logic'
import { type LogicOperator } from '@entities/formSchema'
import { MAX_FILTER_CONDITIONS, needsValue, type FilterCondition } from '../../shared/answerFilter'
import { operatorLabel } from '../../shared/logicLabels'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Фильтр сводки (спека design/analytics-v2.md §6.2): условия через «И», каждое —
// «вопрос, оператор, значение», как лист условия в логике формы. Операторы — те же,
// что предлагает редактор логики для этого типа вопроса (@fields/logic).
//
// Вопросы и варианты берутся из самой сводки: у закрытых вопросов значения — её
// деления (id варианта, число шкалы), у открытых — свободный ввод.
export function AnswerFilterBar({
  blocks,
  conditions,
  onChange,
}: {
  blocks: BlockSummary[]
  conditions: FilterCondition[]
  onChange: (next: FilterCondition[]) => void
}) {
  const byId = new Map(blocks.map((b) => [b.blockId, b]))

  return (
    <div className="flex flex-wrap items-center gap-2">
      {conditions.map((c, i) => {
        const block = byId.get(c.blockId)
        return (
          <span
            key={`${c.blockId}-${i}`}
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted py-1 pr-1 pl-2.5 text-sm"
          >
            <span className="min-w-0 truncate">{conditionText(c, block)}</span>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Убрать условие"
              onClick={() => onChange(conditions.filter((_, j) => j !== i))}
            >
              <X className="size-3.5" />
            </Button>
          </span>
        )
      })}
      {conditions.length < MAX_FILTER_CONDITIONS && (
        <AddCondition blocks={blocks} onAdd={(c) => onChange([...conditions, c])} />
      )}
      {conditions.length > 0 && (
        <Button variant="ghost" size="sm" onClick={() => onChange([])}>
          Сбросить
        </Button>
      )}
    </div>
  )
}

function conditionText(c: FilterCondition, block: BlockSummary | undefined): string {
  if (!block) return 'Вопрос удалён'
  const op = operatorLabel(c.op, block.type)
  if (!needsValue(c.op) || c.value === undefined) return `${block.label} — ${op}`
  const option = block.buckets.find((b) => b.key === c.value)
  return `${block.label} — ${op} «${option?.label ?? c.value}»`
}

function AddCondition({
  blocks,
  onAdd,
}: {
  blocks: BlockSummary[]
  onAdd: (c: FilterCondition) => void
}) {
  const [open, setOpen] = useState(false)
  const [blockId, setBlockId] = useState<string>('')
  const [op, setOp] = useState<LogicOperator | ''>('')
  const [value, setValue] = useState('')

  const candidates = blocks.filter((b) => operatorsFor(b.type).length > 0)
  const block = candidates.find((b) => b.blockId === blockId)
  const ops = block ? operatorsFor(block.type) : []
  // Закрытый вопрос — выбор из делений сводки, открытый — ввод.
  const choices = block && block.kind === 'distribution' ? block.buckets : null
  const ready = block !== undefined && op !== '' && (!needsValue(op) || value.trim() !== '')

  const reset = () => {
    setBlockId('')
    setOp('')
    setValue('')
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" />
          Фильтр
        </Button>
      </PopoverTrigger>
      <PopoverContent className="flex w-80 flex-col gap-3" align="start">
        <Select
          value={blockId}
          onValueChange={(id) => {
            setBlockId(id)
            setOp('')
            setValue('')
          }}
        >
          <SelectTrigger aria-label="Вопрос" className="w-full">
            <SelectValue placeholder="Вопрос…" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((b) => (
              <SelectItem key={b.blockId} value={b.blockId}>
                {b.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {block && (
          <Select
            value={op}
            onValueChange={(next) => {
              setOp(next as LogicOperator)
              setValue('')
            }}
          >
            <SelectTrigger aria-label="Условие" className="w-full">
              <SelectValue placeholder="Условие…" />
            </SelectTrigger>
            <SelectContent>
              {ops.map((o) => (
                <SelectItem key={o} value={o}>
                  {operatorLabel(o, block.type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {block && op !== '' && needsValue(op) &&
          (choices ? (
            <Select value={value} onValueChange={setValue}>
              <SelectTrigger aria-label="Значение" className="w-full">
                <SelectValue placeholder="Значение…" />
              </SelectTrigger>
              <SelectContent>
                {choices.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              aria-label="Значение"
              type={block.type === 'number' ? 'number' : block.type === 'date' ? 'date' : 'text'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          ))}

        <Button
          size="sm"
          disabled={!ready}
          onClick={() => {
            if (!ready) return
            onAdd(needsValue(op) ? { blockId, op, value: value.trim() } : { blockId, op })
            setOpen(false)
            reset()
          }}
        >
          Добавить
        </Button>
      </PopoverContent>
    </Popover>
  )
}
