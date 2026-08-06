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
import { asRootGroup, defaultLeaf, sourcesFor } from './model'

// Диалог «Показывать, если» (фаза 21). Диалог, а не строка в попапе настроек: у
// правила дерево с группами И/ИЛИ, а попап шириной в 240px — место для одной строки,
// не для конструктора.
//
// Правит правило ГОЛОВНОГО блока группы (носитель `visibleIf`), а не того блока, из
// которого открыт: прячется вопрос целиком. Носителя выбирает вызывающий и передаёт
// сюда готовым.
export function LogicDialog({
  open,
  onOpenChange,
  carrier,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  // carrier — носитель правила: головной блок группы вопроса.
  carrier: Block
}) {
  const blocks = useBuilderStore((s) => s.blocks)
  const updateBlock = useBuilderStore((s) => s.updateBlock)

  const sources = sourcesFor(blocks, carrier.id)
  const rule = carrier.visibleIf
  const warnings = ruleWarnings(blocks, carrier.id, rule)

  const setRule = (next: LogicCondition | undefined): void =>
    updateBlock(carrier.id, { visibleIf: next })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Показывать вопрос, если</DialogTitle>
          <DialogDescription>
            Условие смотрит на ответы вопросов ВЫШЕ этого. Пока условие не выполнено, вопрос не
            показывается и не считается обязательным.
          </DialogDescription>
        </DialogHeader>

        {sources.length === 0 ? (
          // Условию не на что смотреть: выше нет ни одного вопроса. Говорим об этом
          // прямо, а не показываем конструктор с пустым списком источников.
          <p className="text-muted-foreground text-sm">
            Условие сравнивает ответ на предыдущий вопрос, а выше этого вопросов пока нет.
            Поставьте его ниже того, от ответа на который он зависит.
          </p>
        ) : rule === undefined ? (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">Сейчас вопрос показывается всегда.</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setRule({ all: [defaultLeaf(sources[0]!)] })}
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
              onChange={(next) => setRule(next)}
              // Убрали последнее условие — правила больше нет, вопрос показывается
              // всегда. Ровно то же делает кнопка «Показывать всегда» ниже.
              onRemove={() => setRule(undefined)}
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
                      Условие не действует: {w.reason}. Пока так — вопрос показывается всем.
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          {rule !== undefined && (
            <Button type="button" variant="ghost" onClick={() => setRule(undefined)}>
              Показывать всегда
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
