import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'

import { type Form, displayFormTitle } from '../../entities/form'
import { FormActionsMenu } from '../../features/forms/FormActionsMenu'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'
import { PageActions, PageCrumbs } from '../../shared/page/headerPortals'
import { ErrorState } from '../../shared/page/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// Оболочка экранов одной формы: «Поделиться», «Аналитика», «Ответы»,
// «Интеграции». Pathless-группа (`_manage` в имени файла не попадает в URL, как
// `_auth`/`_app`) — адреса остаются /forms/{slug}/share|submissions|insights/…,
// поэтому ссылка на экран по-прежнему сохраняется в закладки, F5 не сбрасывает,
// «Назад» браузера работает. Табы обязаны быть маршрутами, а не локальным
// стейтом, именно поэтому.
//
// «Аналитика» — раздел с собственными вкладками (спека design/analytics-tally.md
// §3): «Сводка» и «Отвалы» отвечают на разные вопросы об одной форме, и общими у
// них оказались окно наблюдения и полоса карточек — они живут на оболочке раздела.
// Старые адреса /summary, /funnel и /responses остались редиректами: на первые два
// у владельца закладки, на третий ведут уже разосланные письма о новых ответах.
//
// Путь назад и действие формы уехали в верхний бар кабинета: там же крошки и
// кнопки редактора, и второй шапки под первой у страницы больше нет. Редактор в
// группу не входит — это другой режим, во всю ширину полотна.
export const Route = createFileRoute('/_app/forms/$slug/_manage')({
  component: ManageLayout,
})

// Бейдж статуса ставится только ОТКЛОНЕНИЮ от нормы. «Опубликована» — обычное
// состояние формы, и подпись о нём занимала место, ничего не сообщая; черновик и
// закрытый приём объясняют, почему форма не отвечает на розданную ссылку.
const statusMeta: Partial<
  Record<Form['status'], { label: string; variant: 'secondary' | 'outline' }>
> = {
  draft: { label: 'Черновик', variant: 'secondary' },
  closed: { label: 'Закрыта', variant: 'outline' },
}

function ManageLayout() {
  const { slug } = Route.useParams()
  const form = useQuery(formDetailQueryOptions(slug))
  const workspaceCrumb = useWorkspaceCrumb()

  // Форма не найдена — общий экран на всю группу: рисовать табы над «формы нет»
  // бессмысленно. Свои error-стейты данных у экранов внутри остаются.
  if (form.isError) {
    return (
      <PageContainer>
        <PageCrumbs items={[workspaceCrumb, 'Форма']} />
        <ErrorState
          title="Форма не найдена."
          description="Возможно, её удалили или ссылка устарела."
        />
        <Button asChild variant="outline" size="sm" className="mt-3">
          <Link to="/forms" search={(prev) => prev}>
            Вернуться к списку
          </Link>
        </Button>
      </PageContainer>
    )
  }

  const title = form.data ? displayFormTitle(form.data.title) : 'Форма'
  const meta = form.data ? statusMeta[form.data.status] : undefined

  return (
    <PageContainer>
      <PageCrumbs items={[workspaceCrumb, title]} />
      <PageActions>
        {/* Главное действие над формой — залитая кнопка, а не контурная: в баре она
            одна, и приглушать единственный вход в редактор незачем. */}
        <Button asChild className="gap-1.5">
          <Link to="/forms/$slug/edit" search={(prev) => prev} params={{ slug }}>
            <Pencil className="size-4" /> Редактировать
          </Link>
        </Button>
      </PageActions>

      <PageHeader
        title={title}
        titleAction={form.data && <FormActionsMenu form={form.data} />}
        meta={
          form.data && (
            <>
              {meta && <Badge variant={meta.variant}>{meta.label}</Badge>}
              {form.data.publishedVersion !== null && (
                <span className="text-sm text-muted-foreground">
                  Версия {form.data.publishedVersion}
                </span>
              )}
            </>
          )
        }
      />

      <FormTabs slug={slug} />

      <Outlet />
    </PageContainer>
  )
}

// Табы — настоящие ссылки (навигация, а не переключатель): работают средним кликом,
// «открыть в новой вкладке» и «Назад». Активный подсвечивается через activeProps
// роутера, а не сравнением строк pathname руками.
//
// Свои, а не shadcn Tabs: тот рассчитан на локальный стейт, а у нас маршруты.
function FormTabs({ slug }: { slug: string }) {
  // Классы вида НЕ смешиваются: активный и неактивный набор взаимоисключающи и едут
  // через activeProps/inactiveProps. Держать `border-transparent` в базе и
  // «перебивать» его `border-primary` из activeProps нельзя: у обоих утилит
  // одинаковая специфичность, и побеждает та, что позже в сгенерированном CSS
  // Tailwind, — активный таб оказывается прозрачным, хотя класс на нём есть.
  // Проверять это надо computed-стилем, а не наличием класса в className.
  const base = 'border-b-2 px-1 pb-3 text-sm transition-colors'
  const active = { className: 'border-primary font-semibold text-foreground' }
  const inactive = {
    className: 'border-transparent font-medium text-muted-foreground hover:text-foreground',
  }

  return (
    <nav className="mt-7 mb-8 flex gap-6 border-b" aria-label="Разделы формы">
      <Link
        to="/forms/$slug/share"
        search={(prev) => prev}
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Поделиться
      </Link>
      {/* Ссылка на РАЗДЕЛ, а не на его вкладку: activeProps роутера подсвечивает
          предка открытого маршрута, поэтому «Аналитика» остаётся активной и на
          «Сводке», и на «Отвалах». Ссылка на конкретную вкладку гасла бы на
          соседней. Сам /insights экрана не имеет — его index редиректит на сводку. */}
      <Link
        to="/forms/$slug/insights"
        search={{ period: 'all' }}
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Аналитика
      </Link>
      <Link
        to="/forms/$slug/submissions"
        search={(prev) => prev}
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Ответы
      </Link>
      <Link
        to="/forms/$slug/integrations"
        search={(prev) => prev}
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Интеграции
      </Link>
    </nav>
  )
}
