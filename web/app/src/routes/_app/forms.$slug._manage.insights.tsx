import { createFileRoute, Link, Outlet } from '@tanstack/react-router'

import { periodLabels, periodSchema, type Period } from '../../shared/period'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Раздел «Аналитика» (/forms/$slug/insights): оболочка вкладок «Сводка», «Визиты» и
// «Отвалы» (спека design/analytics-tally.md §3). Держит одно общее — окно
// наблюдения: три копии периода на одном экране разъехались бы на первой правке.
//
// Полосу карточек оболочка НЕ держит: наборов два (трафик и прохождение формы), и
// на «Отвалах» полоса другая — см. features/insights/Cards.tsx.
//
// Период живёт в search-параметре, а не в стейте: иначе ссылка «посмотри на это»
// открывает у получателя другое окно, чем видел отправитель.
export const Route = createFileRoute('/_app/forms/$slug/_manage/insights')({
  validateSearch: (search) => ({ period: periodSchema.parse(search.period) }),
  component: InsightsLayout,
})

function InsightsLayout() {
  const { slug } = Route.useParams()
  const { period } = Route.useSearch()

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <InsightsTabs slug={slug} period={period} />
        <PeriodSelect />
      </div>
      <Outlet />
    </>
  )
}

// Вкладки — настоящие ссылки (навигация, а не переключатель), как и разделы формы
// на оболочке _manage: средний клик и «Назад» обязаны работать. Взаимоисключающие
// наборы классов разведены по activeProps/inactiveProps — смешивать их нельзя
// (у Tailwind-утилит одинаковая специфичность, побеждает порядок в сгенерированном
// CSS, а не в строке className).
function InsightsTabs({ slug, period }: { slug: string; period: Period }) {
  const base = 'rounded-full px-3 py-1.5 text-sm transition-colors'
  const active = { className: 'bg-foreground font-medium text-background' }
  const inactive = { className: 'text-muted-foreground hover:bg-muted hover:text-foreground' }

  return (
    <nav className="flex gap-1" aria-label="Разделы аналитики">
      <Link
        to="/forms/$slug/insights/answers"
        params={{ slug }}
        search={{ period }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Сводка
      </Link>
      <Link
        to="/forms/$slug/insights/visits"
        params={{ slug }}
        search={{ period }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Визиты
      </Link>
      <Link
        to="/forms/$slug/insights/drop-offs"
        params={{ slug }}
        search={{ period }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Отвалы
      </Link>
    </nav>
  )
}

function PeriodSelect() {
  const navigate = Route.useNavigate()
  const { period } = Route.useSearch()

  return (
    <Select
      value={period}
      onValueChange={(value) =>
        void navigate({ search: (prev) => ({ ...prev, period: periodSchema.parse(value) }) })
      }
    >
      <SelectTrigger className="w-[150px]" aria-label="Период">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(periodLabels).map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

