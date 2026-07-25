import type { ShortcutContext } from './shortcuts'
import { commonFor, formatLabel, SHORTCUTS } from './shortcuts'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

// ShortcutSheet — шпаргалка Mod+/ (§7, слой 3): полная карта клавиш ТЕКУЩЕГО
// контекста плюс общий ярус, который у строки намеренно не показывается (чипы
// перечисляют только специфичное — решение владельца 2026-07-25). Источник тот же
// модуль shortcuts.ts, что читают обработчики: расхождение карты с поведением = баг.
//
// ctx приходит снимком: открытие диалога уводит фокус с полотна, активная строка
// гаснет — контекст полотно фиксирует в момент нажатия (см. SlashEditor).

const CONTEXT_TITLES: Record<ShortcutContext, string> = {
  text: 'Текстовая строка',
  option: 'Вариант ответа',
  field: 'Поле ответа',
  image: 'Картинка',
  object: 'Дата и шкала',
  title: 'Название формы',
  canvas: 'Пустое полотно',
}

export function ShortcutSheet({
  ctx,
  open,
  onOpenChange,
}: {
  // null — каретка вне полотна: показываем только то, что работает всегда.
  ctx: ShortcutContext | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const here = ctx ? SHORTCUTS[ctx] : []
  const common = commonFor(ctx ?? 'canvas')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Возврат фокуса Radix'ом здесь НЕ глушим (в отличие от слеш-меню и диалога
          типов): там фокус после выбора ставит движок, а шпаргалка ничего не
          вставляет — закрылась, и каретка обязана вернуться в ту же строку, откуда
          её позвали. Ровно это Radix и делает по умолчанию. */}
      <DialogContent className="max-w-lg sm:max-w-lg">
        <DialogTitle>Горячие клавиши</DialogTitle>
        <DialogDescription className="sr-only">
          Клавиши текущей строки полотна и клавиши, работающие везде.
        </DialogDescription>
        <div className="mt-2 flex flex-col gap-5">
          {ctx && here.length > 0 && <Section title={CONTEXT_TITLES[ctx]} list={here} />}
          <Section title="Везде на полотне" list={common} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Section({
  title,
  list,
}: {
  title: string
  list: readonly { label: string; hint: string }[]
}) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <dl className="flex flex-col gap-1.5">
        {list.map((s) => (
          <div key={s.label} className="flex items-baseline justify-between gap-4">
            <dd className="order-2 text-sm text-muted-foreground">{s.hint}</dd>
            <dt className="order-1">
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-xs text-foreground/80">
                {formatLabel(s.label)}
              </kbd>
            </dt>
          </div>
        ))}
      </dl>
    </section>
  )
}
