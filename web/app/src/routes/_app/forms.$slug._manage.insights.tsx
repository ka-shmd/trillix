import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router'

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
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
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
//
// Search вкладки ДОПОЛНЯЕТСЯ, а не собирается заново: объект-литерал в этом пропе
// адрес не дополняет, а ЗАМЕНЯЕТ (`buildLocation`: функция получает текущий search,
// объект встаёт на его место целиком), и всё, о чём вкладка не знает, — в первую
// очередь `?w=` с пространством — переход молча терял бы. Период при этом называется
// явно, потому что маршрут вкладки требует его непустым.
function InsightsTabs({ slug, period }: { slug: string; period: Period }) {
  // Сегментированный переключатель, как у вендоренного Tabs: разделы формы над ним
  // — подчёркнутые вкладки, и второй ряд того же вида читался бы как продолжение
  // первого. Один и тот же уровень навигации нельзя рисовать дважды подряд.
  const base = 'rounded-md px-2.5 py-1 text-sm transition-colors'
  const active = { className: 'bg-background font-semibold text-foreground shadow-sm' }
  const inactive = { className: 'font-medium text-muted-foreground hover:text-foreground' }

  return (
    <nav
      className="inline-flex h-9 items-center gap-0.5 rounded-lg bg-muted p-[3px]"
      aria-label="Разделы аналитики"
    >
      {/* Сегмент — параметр одних «Отвалов», фильтр ответов — одной «Сводки»: на других
          вкладках они ничего не режут и, оставшись в адресе, выглядели бы действующими. */}
      <Link
        to="/forms/$slug/insights/answers"
        params={{ slug }}
        search={(prev) => ({ ...prev, period, segment: undefined })}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Сводка
      </Link>
      <Link
        to="/forms/$slug/insights/visits"
        params={{ slug }}
        search={(prev) => ({ ...prev, period, segment: undefined, where: undefined })}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Визиты
      </Link>
      <Link
        to="/forms/$slug/insights/drop-offs"
        params={{ slug }}
        search={(prev) => ({ ...prev, period, where: undefined })}
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
  // navigate РОУТЕРА, а не маршрута (Route.useNavigate). Разница несущая: у
  // маршрутного navigate базой служит сам маршрут, то есть оболочка раздела, и
  // переход без `to` уходил на /forms/{slug}/insights — а его index редиректит на
  // «Сводку». Со стороны это выглядело так: меняешь период на вкладке «Визиты» и
  // оказываешься на «Сводке». Роутерный navigate базой берёт ТЕКУЩИЙ адрес,
  // поэтому вкладка остаётся той же, какой была.
  const navigate = useNavigate()
  const { period } = Route.useSearch()

  return (
    <Select
      value={period}
      onValueChange={(value) =>
        void navigate({
          to: '.',
          search: (prev) => ({ ...prev, period: periodSchema.parse(value) }),
        })
      }
    >
      <SelectTrigger className="w-[140px]" aria-label="Период">
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
