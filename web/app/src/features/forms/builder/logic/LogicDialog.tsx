import { TriangleAlert } from 'lucide-react'

import { type Block, type LogicCondition } from '@entities/formSchema'
import { ruleWarnings } from '@fields/logic'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import { useBuilderStore } from '../storeContext'
import { ConditionEditor } from './ConditionEditor'
import { asRootGroup, defaultLeaf, requiredPatch, sourcesFor } from './model'

// Диалог правила (фаза 21). Диалог, а не строка в попапе настроек: у правила дерево с
// группами И/ИЛИ, а попап шириной в 240px — место для одной строки, не для конструктора.
//
// ДИАЛОГ НЕ ЗНАЕТ, ГДЕ ЖИВЁТ ПРАВИЛО: ему дают готовое условие и колбэк записи. Правил
// уже три (видимость вопроса, обязательность по условию, видимость варианта), они лежат
// в трёх разных местах документа и пишутся по-разному — знание об этом внутри диалога
// означало бы третью ветку в каждой его строке. Тексты — единственное, чем правила
// отличаются здесь: дерево, источники и предупреждения у них одни.
export type RuleKind = 'visibleIf' | 'requiredIf' | 'optionVisibleIf'

const COPY: Record<
  RuleKind,
  { title: string; hint: string; empty: string; off: string; inert: string }
> = {
  visibleIf: {
    title: 'Показывать вопрос, если',
    hint: 'Условие смотрит на ответы вопросов ВЫШЕ этого. Пока оно не выполнено, вопрос не показывается и не считается обязательным.',
    empty: 'Сейчас вопрос показывается всегда.',
    off: 'Показывать всегда',
    inert: 'вопрос показывается всем',
  },
  requiredIf: {
    title: 'Обязателен, если',
    hint: 'Пока условие не выполнено, поле можно оставить пустым. Скрытый вопрос не обязателен никогда — видимость старше обязательности.',
    empty: 'Сейчас поле необязательно.',
    off: 'Сделать необязательным',
    inert: 'поле необязательно',
  },
  optionVisibleIf: {
    title: 'Показывать вариант, если',
    hint: 'Условие смотрит на ответы вопросов ВЫШЕ этого списка. Скрытый вариант не показывается и не принимается, даже если прислать его вручную.',
    empty: 'Сейчас вариант показывается всегда.',
    off: 'Показывать всегда',
    inert: 'вариант показывается всем',
  },
}

export function LogicDialog({
  open,
  onOpenChange,
  kind,
  carrierId,
  rule,
  onChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: RuleKind
  // carrierId — блок, ОТНОСИТЕЛЬНО которого условие смотрит назад: у видимости вопроса
  // это голова его группы, у обязательности — само поле, у варианта — блок списка.
  carrierId: string
  rule: LogicCondition | undefined
  onChange: (rule: LogicCondition | undefined) => void
}) {
  const blocks = useBuilderStore((s) => s.blocks)
  const copy = COPY[kind]
  const sources = sourcesFor(blocks, carrierId)
  const warnings = ruleWarnings(blocks, carrierId, rule)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.hint}</DialogDescription>
        </DialogHeader>

        {sources.length === 0 ? (
          // Условию не на что смотреть: выше нет ни одного вопроса. Говорим об этом
          // прямо, а не показываем конструктор с пустым списком источников.
          <p className="text-muted-foreground text-sm">
            Условие сравнивает ответ на предыдущий вопрос, а выше пока нет ни одного.
            Поставьте этот вопрос ниже того, от ответа на который он зависит.
          </p>
        ) : rule === undefined ? (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">{copy.empty}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onChange({ all: [defaultLeaf(sources[0]!)] })}
            >
              Добавить условие
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <ConditionEditor
              blocks={blocks}
              sources={sources}
              value={asRootGroup(rule)}
              onChange={onChange}
              // Убрали последнее условие — правила больше нет. Ровно то же делает
              // кнопка внизу.
              onRemove={() => onChange(undefined)}
            />

            {/* Предупреждения — не ошибки: такой документ валиден, просто правило не
                действует. Схема запретить это не может (кросс-блочное), поэтому
                единственное место, где автор об этом узнаёт, — здесь. */}
            {warnings.length > 0 && (
              <ul className="space-y-1 text-sm text-amber-600 dark:text-amber-500">
                {warnings.map((w, i) => (
                  <li key={`${w.blockId}:${i}`} className="flex items-start gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Условие не действует: {w.reason}. Пока так — {copy.inert}.
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          {rule !== undefined && (
            <Button type="button" variant="ghost" onClick={() => onChange(undefined)}>
              {copy.off}
            </Button>
          )}
          <Button type="button" onClick={() => onOpenChange(false)}>
            Готово
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// BlockRuleDialog — два правила, живущие на самом блоке. Запись у них разная
// (обязательность по условию чистит парный флаг — схема запрещает их вместе), и держать
// эту разницу здесь, в одном месте, дешевле, чем у каждого вызывающего.
export function BlockRuleDialog({
  open,
  onOpenChange,
  kind,
  carrier,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: 'visibleIf' | 'requiredIf'
  carrier: Block
}) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  return (
    <LogicDialog
      open={open}
      onOpenChange={onOpenChange}
      kind={kind}
      carrierId={carrier.id}
      rule={kind === 'visibleIf' ? carrier.visibleIf : carrier.requiredIf}
      onChange={(next) =>
        updateBlock(
          carrier.id,
          kind === 'visibleIf'
            ? { visibleIf: next }
            : requiredPatch(next === undefined ? 'no' : 'conditional', next),
        )
      }
    />
  )
}

// OptionRuleDialog — правило варианта. Носитель условия для «смотрит назад» — БЛОК
// списка, а не вариант: вариант живёт там же, где список, и вопросы выше у них общие.
export function OptionRuleDialog({
  open,
  onOpenChange,
  block,
  optionId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  block: Block
  optionId: string
}) {
  const setOptionRule = useBuilderStore((s) => s.setOptionRule)
  const option = block.settings?.options?.find((o) => o.id === optionId)
  return (
    <LogicDialog
      open={open}
      onOpenChange={onOpenChange}
      kind="optionVisibleIf"
      carrierId={block.id}
      rule={option?.visibleIf}
      onChange={(next) => setOptionRule(block.id, optionId, next)}
    />
  )
}
