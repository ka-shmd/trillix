import type { ShortcutContext, ShortcutFilters } from './shortcuts'
import { commonFor, formatLabel, shortcutsFor } from './shortcuts'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

// ShortcutSheet — шпаргалка Mod+/: карта клавиш ТЕКУЩЕЙ строки плюс общий ярус.
// С 2026-07-29 это ЕДИНСТВЕННАЯ поверхность карты (чипы у строки сняты, кроме
// действия «дать полю заголовок»), поэтому печатает она не весь список контекста, а
// то, что на этой строке работает: filters отсеивают пункты, которые здесь молчат
// (Mod+Enter без поля ответа, Alt+↑↓ на подписи вопроса, Mod+Alt+T у собранного).
// Источник тот же модуль shortcuts.ts, что читают обработчики: расхождение карты с
// поведением = баг.
//
// Контекст и признаки приходят СНИМКОМ: открытие диалога уводит фокус с полотна и
// гасит активную строку, а шпаргалка обязана показывать ту, из которой её позвали
// (см. SlashEditor).

const CONTEXT_TITLES: Record<ShortcutContext, string> = {
  text: 'Текстовая строка',
  option: 'Вариант ответа',
  newOption: 'Новый вариант',
  field: 'Поле ответа',
  image: 'Картинка',
  object: 'Дата и шкала',
  title: 'Название формы',
  canvas: 'Пустое полотно',
}

export function ShortcutSheet({
  ctx,
  filters,
  open,
  onOpenChange,
}: {
  // null — каретка вне полотна: показываем только то, что работает всегда.
  ctx: ShortcutContext | null
  // Признаки строки, из которой позвали шпаргалку (снимок, как и ctx).
  filters?: ShortcutFilters
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const here = ctx ? shortcutsFor(ctx, filters) : []
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
        <div className="mt-2 flex flex-col gap-6">
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
      <h3 className="mb-2 text-base font-semibold">
        {title}
      </h3>
      <dl className="flex flex-col gap-2">
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
