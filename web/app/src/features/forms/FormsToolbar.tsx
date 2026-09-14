import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import {
  FORMS_FILTER_LABELS,
  FORMS_SORT_LABELS,
  formsFilterSchema,
  formsSortSchema,
  type FormsFilter,
  type FormsSort,
} from '../../entities/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Панель списка форм: поиск по названию, фильтр по статусу и порядок. Все три
// значения живут в адресной строке (владеет ими маршрут) — сюда приходят пропсами.
export function FormsToolbar({
  q,
  sort,
  filter,
  onSearchChange,
  onSortChange,
  onFilterChange,
}: {
  q: string
  sort: FormsSort
  filter: FormsFilter
  onSearchChange: (q: string) => void
  onSortChange: (sort: FormsSort) => void
  onFilterChange: (filter: FormsFilter) => void
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
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative min-w-56 flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
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
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Отбор по статусу делает СЕРВЕР (?status=) — список постраничный, и
          просеивание подгруженного молча теряло бы формы с неподгруженных страниц. */}
      <Select
        value={filter}
        onValueChange={(value) => {
          // safeParse, а не parse: значения свои, но бросать исключение из
          // обработчика — значит ронять экран там, где достаточно ничего не делать.
          const parsed = formsFilterSchema.safeParse(value)
          if (parsed.success) onFilterChange(parsed.data)
        }}
      >
        <SelectTrigger className="w-44" aria-label="Фильтр по статусу">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {formsFilterSchema.options.map((value) => (
            <SelectItem key={value} value={value}>
              {FORMS_FILTER_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Подписи «Сортировка» у селектора нет: он и так показывает выбранный
          порядок словами («По дате изменения»), а подпись стоила 90 px в ряду, где
          ширина нужна поиску. Скринридеру порядок называет aria-label. */}
      <Select
        value={sort}
        onValueChange={(value) => {
          const parsed = formsSortSchema.safeParse(value)
          if (parsed.success) onSortChange(parsed.data)
        }}
      >
        <SelectTrigger className="w-52" aria-label="Сортировка">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {formsSortSchema.options.map((value) => (
            <SelectItem key={value} value={value}>
              {FORMS_SORT_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
