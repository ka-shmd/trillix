import { Plus, TriangleAlert, X } from 'lucide-react'

import {
  type Block,
  type JumpRule,
  type LogicCondition,
  MAX_JUMP_RULES,
} from '@entities/formSchema'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { useBuilderStore } from '../storeContext'
import { ConditionEditor } from './ConditionEditor'
import { JUMP_END, asRootGroup, defaultLeaf, jumpTargets, sourcesFor } from './model'

// Диалог переходов со страницы (фаза 21, слайс 5). Правила висят на разрыве, который
// страницу ЗАКРЫВАЕТ: «ухожу отсюда — куда». Порядок = приоритет, побеждает первое
// сработавшее; не сработало ни одно — идём на следующую страницу, как до фазы.
//
// Цели — только вперёд (jumpTargets). Переход назад инертен по построению обхода, и
// показывать его в списке значило бы пообещать работу, которой не будет: монотонный
// обход — это то, на чём стоит завершаемость прохода и считаемость линий шагов.
export function JumpDialog({
  open,
  onOpenChange,
  block,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  // block — разрыв страницы, носитель правил.
  block: Block
}) {
  const blocks = useBuilderStore((s) => s.blocks)
  const updateBlock = useBuilderStore((s) => s.updateBlock)

  const rules = block.jumpIf ?? []
  const sources = sourcesFor(blocks, block.id)
  const targets = jumpTargets(blocks, block.id)

  const setRules = (next: JumpRule[]): void =>
    updateBlock(block.id, { jumpIf: next.length > 0 ? next : undefined })

  const replaceRule = (i: number, next: JumpRule | null): void =>
    setRules(
      next === null ? rules.filter((_, j) => j !== i) : rules.map((r, j) => (j === i ? next : r)),
    )

  // Новое правило: первое доступное условие и первая цель. Цель обязательна с самого
  // начала — правило «если …, то никуда» невыразимо в схеме (ровно одна цель), и
  // недособранное состояние здесь ловило бы 422 в автосейве.
  const addRule = (): void => {
    const source = sources[0]
    const target = targets[0]
    if (!source || !target) return
    setRules([...rules, { when: { all: [defaultLeaf(source)] }, ...targetPatch(target.value) }])
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Переходы с этой страницы</DialogTitle>
          <DialogDescription>
            Проверяются сверху вниз, когда респондент нажимает «Далее»: срабатывает первое
            подходящее правило. Не сработало ни одно — открывается следующая страница.
          </DialogDescription>
        </DialogHeader>

        {sources.length === 0 || targets.length === 0 ? (
          // Две настоящие причины, при которых правило собрать нельзя, и никаких других:
          // смотреть не на что (выше разрыва нет вопросов) либо этот разрыв ничего не
          // делит (два подряд, разрыв в самом конце — он инертен и у респондента страницы
          // не открывает вовсе).
          //
          // «За разрывом нет других страниц» причиной НЕ является: переход «к отправке»
          // осмыслен и у единственного разрыва — он и есть главный сценарий ветки
          // «дальше спрашивать нечего, отправляем». Здесь я это перепутал, и диалог
          // отказывал ровно там, где нужен чаще всего.
          <p className="text-muted-foreground text-sm">
            {targets.length === 0
              ? 'Этот разрыв не делит форму, поэтому уходить с этой страницы некуда: у респондента он не открывает новую. Так бывает, когда разрыв стоит первым, последним или вплотную к другому разрыву — поставьте его между вопросами.'
              : 'Условие сравнивает ответ на вопрос выше этого разрыва, а таких пока нет.'}
          </p>
        ) : (
          <div className="space-y-4">
            {rules.map((rule, i) => (
              <RuleCard
                key={i}
                blocks={blocks}
                sources={sources}
                targets={targets}
                carrierId={block.id}
                rule={rule}
                onChange={(next) => replaceRule(i, next)}
                onRemove={() => replaceRule(i, null)}
              />
            ))}
            {/* Сверх лимита схемы кнопку не показываем: 422 в автосейве от нажатия
                собственной кнопки — худший способ узнать про лимит. */}
            {rules.length < MAX_JUMP_RULES && (
              <Button type="button" variant="secondary" size="sm" onClick={addRule}>
                <Plus className="size-3.5" />
                Переход
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Готово
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// targetPatch — цель в форме схемы: ЛИБО id разрыва, ЛИБО флаг end. Две формы, а не
// зарезервированная строка внутри to: id генерирует клиент, и 'end' — законный id.
function targetPatch(value: string): { to?: string; end?: true } {
  return value === JUMP_END ? { end: true } : { to: value }
}

const targetValue = (rule: JumpRule): string => (rule.end === true ? JUMP_END : (rule.to ?? ''))

function RuleCard({
  blocks,
  sources,
  targets,
  carrierId,
  rule,
  onChange,
  onRemove,
}: {
  blocks: readonly Block[]
  sources: readonly Block[]
  targets: { value: string; label: string }[]
  carrierId: string
  rule: JumpRule
  onChange: (next: JumpRule) => void
  onRemove: () => void
}) {
  const warnings = ruleWarnings(blocks, carrierId, rule.when)
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs uppercase tracking-wide">Если</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Удалить переход"
          onClick={onRemove}
        >
          <X className="size-4" />
        </Button>
      </div>

      <ConditionEditor
        blocks={blocks}
        sources={sources}
        value={asRootGroup(rule.when as LogicCondition)}
        onChange={(when) => onChange({ ...rule, when })}
        // Убрали последнее условие — правило целиком теряет смысл: переход без условия
        // сработал бы всегда, то есть просто переставил бы порядок страниц.
        onRemove={onRemove}
      />

      <div className="flex items-center gap-2">
        <span className="text-muted-foreground shrink-0 text-sm">Перейти:</span>
        <Select
          value={targetValue(rule)}
          onValueChange={(v) => onChange({ when: rule.when, ...targetPatch(v) })}
        >
          <SelectTrigger size="sm" className="h-7 w-44" aria-label="Куда перейти">
            <SelectValue placeholder="Выберите страницу" />
          </SelectTrigger>
          <SelectContent>
            {targets.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {warnings.length > 0 && (
        <ul className="space-y-1 text-sm text-amber-600 dark:text-amber-500">
          {warnings.map((w, i) => (
            <li key={`${w.blockId}:${i}`} className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>Переход не сработает: {w.reason}.</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
