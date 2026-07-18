import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { FORMS_SORT_LABELS, formsSortSchema, type FormsSort } from '../../entities/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Панель дашборда: поиск по названию и порядок списка. Оба значения живут в
// адресной строке (владеет ими маршрут) — сюда приходят пропсами.
export function FormsToolbar({
  q,
  sort,
  onSearchChange,
  onSortChange,
}: {
  q: string
  sort: FormsSort
  onSearchChange: (q: string) => void
  onSortChange: (sort: FormsSort) => void
}) {
  // Поле держит локальный черновик: буква попадает в адрес и в запрос не сразу,
  // иначе каждое нажатие — свой запрос и своя запись в истории браузера.
  const [draft, setDraft] = useState(q)

  // Внешнее изменение (кнопка «Назад», сброс поиска из пустого состояния) обязано
  // вернуться в поле. Правка состояния прямо в рендере — штатный приём React для
  // «подстроиться под изменившийся проп»; эффект здесь дал бы лишний проход
  // рендера и мигание прежним значением.
  const [syncedQ, setSyncedQ] = useState(q)
  if (q !== syncedQ) {
    setSyncedQ(q)
    setDraft(q)
  }

  // Колбэк — через ref, а не в зависимостях эффекта: таймер обязан зависеть только
  // от набранного текста. Стоит вызывающему отдать нестабильную функцию (или
  // useNavigate однажды перестать быть стабильным), и эффект перезапускался бы на
  // каждом рендере, сбрасывая отсчёт, — debounce тихо перестал бы работать.
  const onSearchChangeRef = useRef(onSearchChange)
  useEffect(() => {
    onSearchChangeRef.current = onSearchChange
  })

  useEffect(() => {
    if (draft === q) return
    const timer = setTimeout(() => onSearchChangeRef.current(draft), 300)
    return () => clearTimeout(timer)
  }, [draft, q])

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <div className="relative min-w-56 flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Поиск по названию"
          aria-label="Поиск по названию"
          className="pl-9"
        />
        {draft !== '' && (
          <button
            type="button"
            onClick={() => setDraft('')}
            aria-label="Очистить поиск"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Label htmlFor="forms-sort" className="shrink-0 text-sm text-muted-foreground">
          Сортировка
        </Label>
        {/* Нативный select: shadcn-версия тянет @radix-ui/react-select — новая
            зависимость, список заморожен (web/CLAUDE.md). */}
        <select
          id="forms-sort"
          value={sort}
          onChange={(e) => {
            // safeParse, а не parse: значения свои, но бросать исключение из
            // обработчика события — значит ронять экран целиком там, где
            // достаточно ничего не делать.
            const parsed = formsSortSchema.safeParse(e.target.value)
            if (parsed.success) onSortChange(parsed.data)
          }}
          className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {formsSortSchema.options.map((value) => (
            <option key={value} value={value}>
              {FORMS_SORT_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
