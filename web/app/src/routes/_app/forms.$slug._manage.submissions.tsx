import { createFileRoute, Link, Outlet } from '@tanstack/react-router'

// Раздел «Ответы» (/forms/$slug/submissions): оболочка вкладок «Все ответы»,
// «Законченные» и «Частичные» (спека design/analytics-tally.md §3, §11).
//
// ВКЛАДКИ СТОЯТ, СОДЕРЖИМОЕ ДОЕДЕТ (решение владельца). Спека требует обратного —
// «вкладки появляются вместе со своим содержимым, а не пустыми заглушками», — но ручки
// на чтение черновиков сегодня нет вовсе, и владелец делает её следующей задачей.
// Поэтому «Все ответы» и «Законченные» показывают один и тот же поток отправленных
// ответов, а «Частичные» — заглушку.
//
// Шапка страницы, крошки и общие табы формы — на оболочке _manage; колонка этой
// вкладки идёт без потолка ширины, её тоже выбирает та оболочка по маршруту.
export const Route = createFileRoute('/_app/forms/$slug/_manage/submissions')({
  component: SubmissionsLayout,
})

function SubmissionsLayout() {
  const { slug } = Route.useParams()

  return (
    <>
      <div className="mb-8">
        <SubmissionsTabs slug={slug} />
      </div>
      <Outlet />
    </>
  )
}

// Вкладки — настоящие ссылки (навигация, а не переключатель), как и разделы формы на
// оболочке _manage: средний клик, «открыть в новой вкладке» и «Назад» обязаны работать.
// Взаимоисключающие наборы классов разведены по activeProps/inactiveProps — смешивать их
// нельзя (у Tailwind-утилит одинаковая специфичность, побеждает порядок в сгенерированном
// CSS, а не в строке className).
//
// Сегментированный переключатель, тот же, что у вкладок аналитики: разделы формы над ним
// — подчёркнутые вкладки, и второй ряд того же вида читался бы как продолжение первого.
function SubmissionsTabs({ slug }: { slug: string }) {
  const base = 'rounded-md px-2.5 py-1 text-sm transition-colors'
  const active = { className: 'bg-background font-semibold text-foreground shadow-sm' }
  const inactive = { className: 'font-medium text-muted-foreground hover:text-foreground' }

  return (
    <nav
      className="inline-flex h-9 items-center gap-0.5 rounded-lg bg-muted p-[3px]"
      aria-label="Разделы ответов"
    >
      <Link
        to="/forms/$slug/submissions/all"
        params={{ slug }}
        search={(prev) => prev}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Все ответы
      </Link>
      <Link
        to="/forms/$slug/submissions/completed"
        params={{ slug }}
        search={(prev) => prev}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Законченные
      </Link>
      <Link
        to="/forms/$slug/submissions/partial"
        params={{ slug }}
        search={(prev) => prev}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Частичные
      </Link>
    </nav>
  )
}
