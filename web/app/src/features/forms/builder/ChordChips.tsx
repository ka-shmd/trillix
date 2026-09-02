import { formatLabel } from './shortcuts'

// ChordChips — аккорд клавишами по отдельности: [Alt] [J], а не одна плашка «Alt+J»
// (решение владельца 2026-09-02). Клавиш в аккорде столько, сколько нажимать, и
// разделённые чипы читаются как жест, а слитная строка — как название команды.
//
// Ярлык приходит из карты шорткатов (`labelFor`), а не пишется на месте: подпись на
// контроле и обещание шпаргалки Mod+/ обязаны совпадать.
//
// aria-hidden у всей группы: клавиши — украшение подписи, а не её часть. Кнопка уже
// названа словами («Помощь ИИ»), и озвучивать «Помощь ИИ Alt J» скринридеру незачем —
// сам жест он объявит, когда автор его нажмёт.
export function ChordChips({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {formatLabel(label)
        .split('+')
        .map((key) => (
          <kbd
            key={key}
            className="rounded border border-border bg-muted px-1 py-px font-sans text-xs leading-4 font-normal text-foreground/70"
          >
            {key}
          </kbd>
        ))}
    </span>
  )
}
