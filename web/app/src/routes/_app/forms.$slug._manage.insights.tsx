import { createFileRoute, Link, Outlet, useNavigate } from '@tanstack/react-router'

import { periodLabels, periodSchema, type Period } from '../../shared/period'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Раздел «Аналитика» (/forms/$slug/insights): оболочка вкладок «Обзор», «Визиты» и
// «Ответы» (спека design/analytics-v3.md §2). Держит одно общее — окно
// наблюдения: три копии периода на одном экране разъехались бы на первой правке.
//
// Полоса карточек с фазы 30 одна на все вкладки (features/insights/Cards.tsx), но
// оболочка её всё равно НЕ держит: полоса режется сегментом, а сегмент живёт в
// search КОНКРЕТНОЙ вкладки и оболочке не объявлен. Подняв полосу сюда, пришлось бы
// читать здесь непровалидированный ключ соседнего маршрута.
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
      {/* Сегмент режет «Обзор» и «Ответы», фильтр ответов — одни «Ответы»; «Визиты» не
          режет ни то ни другое, и оставшись в адресе, они выглядели бы там действующими.
          Между «Обзором» и «Ответами» сегмент переходит вместе с адресом.

          Порядок вкладок — порядок вопросов владельца: как работает форма → кто
          приходит → что отвечают. */}
      {/* «Обзор» живёт на index раздела, поэтому его адрес — префикс адресов соседей,
          и без activeOptions.exact роутер считал бы его активным на всех трёх
          вкладках сразу. */}
      <Link
        to="/forms/$slug/insights"
        params={{ slug }}
        search={(prev) => ({ ...prev, period, where: undefined })}
        className={base}
        activeOptions={{ exact: true }}
        activeProps={active}
        inactiveProps={inactive}
      >
        Обзор
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
        to="/forms/$slug/insights/answers"
        params={{ slug }}
        search={(prev) => ({ ...prev, period })}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Ответы
      </Link>
    </nav>
  )
}

function PeriodSelect() {
  // navigate РОУТЕРА, а не маршрута (Route.useNavigate). Разница несущая: у
  // маршрутного navigate базой служит сам маршрут, то есть оболочка раздела, и
  // переход без `to` уходил бы на /forms/{slug}/insights — то есть на «Обзор».
  // Со стороны это выглядит так: меняешь период на вкладке «Визиты» и
  // оказываешься на «Обзоре». Роутерный navigate базой берёт ТЕКУЩИЙ адрес,
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
