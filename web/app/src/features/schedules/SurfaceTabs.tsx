// Две поверхности полотна расписания — переключатель в баре (ADR §10).
//
// «Приём» отвечает на вопрос «какие у меня часы», и его задают раз, а потом месяцами
// не трогают. «Календарь» отвечает на «кто ко мне придёт», и с ним работают каждый
// день. Занятия разнесены во времени, поэтому режим здесь оправдан: между вкладками
// не скачут. Окажется, что скачут, — модель неверна.
export type Surface = 'rule' | 'calendar'

const TABS: { value: Surface; title: string }[] = [
  { value: 'calendar', title: 'Календарь' },
  { value: 'rule', title: 'Приём' },
]

export function SurfaceTabs({
  surface,
  onSurface,
}: {
  surface: Surface
  onSurface: (s: Surface) => void
}) {
  return (
    // Сегментами, а не двумя одинаковыми кнопками: выбрана всегда ровно одна, и
    // группа должна читаться как один орган управления — тот же приём, что у
    // переключателя видов справа.
    <div className="flex rounded-md border p-0.5">
      {TABS.map((t) => (
        <button
          key={t.value}
          type="button"
          aria-pressed={surface === t.value}
          className={
            surface === t.value
              ? 'rounded-sm bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground'
              : 'rounded-sm px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground'
          }
          onClick={() => onSurface(t.value)}
        >
          {t.title}
        </button>
      ))}
    </div>
  )
}
