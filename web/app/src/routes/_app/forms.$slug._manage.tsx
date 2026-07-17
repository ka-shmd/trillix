import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Pencil } from 'lucide-react'

import { type Form, displayFormTitle } from '../../entities/form'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// Оболочка трёх экранов одной формы: «Поделиться», «Ответы», «Сводка». Pathless-
// группа (`_manage` в имени файла не попадает в URL, как `_auth`/`_app`) — адреса
// остаются /forms/{slug}/share|responses|summary, поэтому ссылка на сводку
// по-прежнему сохраняется в закладки, F5 не сбрасывает, «Назад» браузера работает.
// Табы обязаны быть маршрутами, а не локальным стейтом, именно поэтому.
//
// Общая шапка (назад, название, статус, «Редактировать») живёт здесь: до этого
// каждый из трёх экранов рисовал свою, почти такую же. Редактор в группу не входит —
// это другой режим, во всю ширину полотна и со своей шапкой.
export const Route = createFileRoute('/_app/forms/$slug/_manage')({
  component: ManageLayout,
})

const statusMeta: Record<Form['status'], { label: string; variant: 'secondary' | 'default' | 'outline' }> = {
  draft: { label: 'Черновик', variant: 'secondary' },
  published: { label: 'Опубликована', variant: 'default' },
  closed: { label: 'Закрыта', variant: 'outline' },
}

function ManageLayout() {
  const { slug } = Route.useParams()
  const form = useQuery(formDetailQueryOptions(slug))

  // Форма не найдена — общий экран на всю группу: рисовать табы над «формы нет»
  // бессмысленно. Свои error-стейты данных у экранов внутри остаются.
  if (form.isError) {
    return (
      <div role="alert" className="m-6 rounded-lg border border-destructive/40 bg-destructive/5 p-6">
        <p className="mb-3 text-sm">Форма не найдена.</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/forms">Вернуться к списку</Link>
        </Button>
      </div>
    )
  }

  const meta = form.data ? statusMeta[form.data.status] : null

  return (
    <section className="mx-auto max-w-4xl p-6">
      <Link
        to="/forms"
        className="mb-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> К формам
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {form.data ? displayFormTitle(form.data.title) : 'Форма'}
          </h1>
          {form.data && meta && (
            <div className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant={meta.variant}>{meta.label}</Badge>
              {form.data.publishedVersion !== null && <span>Версия {form.data.publishedVersion}</span>}
            </div>
          )}
        </div>
        <Button asChild variant="outline" className="gap-1.5">
          <Link to="/forms/$slug/edit" params={{ slug }}>
            <Pencil className="size-4" /> Редактировать
          </Link>
        </Button>
      </header>

      <FormTabs slug={slug} />

      <Outlet />
    </section>
  )
}

// Табы — настоящие ссылки (навигация, а не переключатель): работают средним кликом,
// «открыть в новой вкладке» и «Назад». Активный подсвечивается через activeProps
// роутера, а не сравнением строк pathname руками.
//
// Свои, а не shadcn Tabs: тот тянет @radix-ui/react-tabs — новая зависимость (список
// заморожен, web/CLAUDE.md), и рассчитан на локальный стейт, а у нас маршруты.
function FormTabs({ slug }: { slug: string }) {
  // Классы вида НЕ смешиваются: активный и неактивный набор взаимоисключающи и едут
  // через activeProps/inactiveProps. Держать `border-transparent` в базе и
  // «перебивать» его `border-primary` из activeProps нельзя: у обоих утилит
  // одинаковая специфичность, и побеждает та, что позже в сгенерированном CSS
  // Tailwind, — активный таб оказывается прозрачным, хотя класс на нём есть.
  // Проверять это надо computed-стилем, а не наличием класса в className.
  const base = 'border-b-2 px-1 pb-2.5 text-sm transition-colors'
  const active = { className: 'border-primary font-semibold text-foreground' }
  const inactive = {
    className: 'border-transparent font-medium text-muted-foreground hover:text-foreground',
  }

  return (
    <nav className="mt-6 mb-6 flex gap-6 border-b" aria-label="Разделы формы">
      <Link
        to="/forms/$slug/share"
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Поделиться
      </Link>
      <Link
        to="/forms/$slug/responses"
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Ответы
      </Link>
      <Link
        to="/forms/$slug/summary"
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Сводка
      </Link>
    </nav>
  )
}
