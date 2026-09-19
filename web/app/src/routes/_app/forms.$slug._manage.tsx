import { createFileRoute, Link, Outlet, useMatchRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Copy, Pencil } from 'lucide-react'

import { type Form, displayFormTitle } from '../../entities/form'
import { FormActionsMenu } from '../../features/forms/FormActionsMenu'
import { copyFormLink } from '../../features/forms/copyLink'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { MemberCluster } from '../../features/workspaces/MemberCluster'
import { useCurrentWorkspace } from '../../features/workspaces/current'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
import { useDeclareWorkspace } from '../../shared/workspaceContext'
import { periodSchema } from '../../shared/period'
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
  // Ширину задаёт открытая вкладка — и только СОДЕРЖИМОМУ. Крошки, название формы
  // и ряд табов стоят в своей колонке одной ширины на все вкладки: разъедься она, и
  // название с табами прыгало бы по экрану при каждом переключении раздела. Без
  // потолка ширины идёт только таблица ответов, которой этот потолок оборачивается
  // прокруткой вбок при пустых полях по краям.
  //
  // Совпадение НЕЧЁТКОЕ (`fuzzy`): у раздела «Ответы» свои вкладки, и адрес всегда
  // длиннее самого раздела (/submissions/all и далее). Точное сравнение не совпало бы
  // ни разу, и колонка молча осталась бы обычной ширины.
  const matchRoute = useMatchRoute()
  // Колонка у всех вкладок ОДНА, кроме таблицы ответов: левый край содержимого
  // обязан совпасть с левым краем названия формы и ряда табов (решение владельца
  // 2026-08-29 — настройки стояли в узкой колонке по центру, и края расходились на
  // 112px). Узкая колонка «экрана решений» этой цены не стоит: расхождение видно
  // на каждом широком экране, читаемая мера строки — только на настройках.
  const contentWidth = matchRoute({ to: '/forms/$slug/submissions', fuzzy: true })
    ? 'full'
    : 'default'
  // Экраны формы пространства в адресе не несут — его знает сама форма. Отсюда
  // оболочка кабинета (крошка, подсветка сайдбара, гейты тарифа) и узнаёт, где стоит
  // человек: прямая ссылка на форму из письма или закладки читается верно, а не как
  // личное пространство (`shared/workspaceContext.tsx`).
  useDeclareWorkspace(form.data?.workspaceSlug)
  const workspaceCrumb = useWorkspaceCrumb()
  // Пространство берётся из адреса — то же, что показывает крошка. Нет его (список
  // ещё едет либо slug чужой) — кластер не рисуем: пустое место честнее, чем кружки
  // не тех людей.
  const workspace = useCurrentWorkspace()

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
          <Link to="/forms">Вернуться к списку</Link>
        </Button>
      </PageContainer>
    )
  }

  const title = form.data ? displayFormTitle(form.data.title) : 'Форма'
  const meta = form.data ? statusMeta[form.data.status] : undefined

  // Шапка и содержимое — ДВЕ колонки, а не одна: у них разная ширина. Вертикальные
  // поля страницы поделены между ними (верхнее у шапки, нижнее у содержимого),
  // поэтому на глаз это по-прежнему одна страница.
  return (
    <>
      <PageContainer className="pb-0">
        <PageCrumbs items={[workspaceCrumb, title]} />
        {/* Правая часть бара — от общего к частному: кто в пространстве, ссылка на
          форму, вход в редактор. Залитая кнопка стоит последней, у самого края:
          она главная, и цветное пятно на краю читается как конец ряда. */}
        <PageActions>
          {/* Кластер в баре — без поля и без подложки на наведении: он читается как
            «вот эти люди», а не как кнопка, и подсветка делала из ряда лиц ещё один
            орган управления. Кольцо фокуса остаётся — иначе клавиатурой до состава
            не добраться.

            Тёмный вариант гасится ОТДЕЛЬНО: `hover:bg-transparent` убирает только
            светлый `hover:bg-accent`, а `dark:hover:bg-accent/50` живёт под своим
            вариантом, специфичнее, и вернул бы подложку при включении темы. */}
          {workspace && (
            <MemberCluster
              workspace={workspace}
              className="px-0 hover:bg-transparent dark:hover:bg-transparent"
            />
          )}
          {/* Копирование ссылки вынесено из меню: действие частое, а ради него
            приходилось открывать меню. Со СЛОВАМИ, а не значком: значок копирования
            и значок ссылки одинаково правдоподобны, и угадывать, который тут,
            человек не должен. У черновика выключено — публичной страницы у него
            ещё нет. */}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={form.data?.status === 'draft'}
            onClick={() => copyFormLink(slug)}
          >
            <Copy className="size-4" />
            Копировать ссылку
          </Button>
          {/* Главное действие над формой — залитая кнопка, а не контурная: в баре она
            одна такая, и приглушать единственный вход в редактор незачем. Размер
            малый: бар высотой 48px, кнопка в полный рост подпирала бы его края.
            Геометрия ряда — штатный `size="sm"` (28px, поля 8 при значке), тот же, что
            у кнопок бара редактора: переход «Поделиться → Редактировать» не двигает ряд.

            Отступа перед кнопкой нет намеренно. У ghost-кнопки видимая граница —
            её текст, у залитой — край заливки, поэтому её собственные 8px поля уже
            и есть тот зазор, который видит глаз. */}
          {/* Кнопка появляется вместе с формой: адрес редактора называет
            пространство, а знает его сама форма. */}
          {form.data && (
            <Button asChild size="sm">
              <Link
                to="/w/$workspaceSlug/forms/$slug/edit"
                params={{ workspaceSlug: form.data.workspaceSlug, slug }}
              >
                <Pencil className="size-3.5" /> Редактировать
              </Link>
            </Button>
          )}
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
      </PageContainer>

      <PageContainer width={contentWidth} className="pt-0">
        <Outlet />
      </PageContainer>
    </>
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
  const base = 'border-b-2 px-0.5 pb-2 text-sm transition-colors'
  const active = { className: 'border-primary font-semibold text-foreground' }
  const inactive = {
    className: 'border-transparent font-medium text-muted-foreground hover:text-foreground',
  }

  return (
    <nav className="mt-6 mb-8 flex gap-4 border-b" aria-label="Разделы формы">
      <Link
        to="/forms/$slug/share"
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Поделиться
      </Link>
      {/* Ссылка на РАЗДЕЛ, а не на его вкладку: activeProps роутера подсвечивает
          предка открытого маршрута, поэтому «Аналитика» остаётся активной на всех
          трёх вкладках. Ссылка на конкретную вкладку гасла бы на соседней. Этот же
          адрес открывает «Обзор» — он живёт на index раздела, поэтому здесь
          activeOptions не нужны: подсветка предка — ровно то, что требуется.

          Период здесь ДОБИРАЕТСЯ ИЗ АДРЕСА, а не назначается: `periodSchema` отдаёт
          названное окно как есть, а неназванное и непонятное — умолчанием. Вбитая
          сюда константа гасила бы подсветку на любом другом периоде: роутер считает
          ссылку активной, только когда её search — подмножество текущего. */}
      <Link
        to="/forms/$slug/insights"
        search={(prev) => ({ ...prev, period: periodSchema.parse(prev.period) })}
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Аналитика
      </Link>
      <Link
        to="/forms/$slug/submissions"
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Ответы
      </Link>
      <Link
        to="/forms/$slug/integrations"
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Интеграции
      </Link>
      {/* Настройки — ПОСЛЕДНИЙ таб: это не работа с формой, а её условия, и открывают
          их редко. Раздел, а не режим редактора (решение владельца 2026-08-26):
          отсюда у настроек появился адрес, и на тумблер сбора незавершённых можно
          послать ссылкой со вкладки «Частичные». */}
      <Link
        to="/forms/$slug/settings"
        params={{ slug }}
        className={base}
        activeProps={active}
        inactiveProps={inactive}
      >
        Настройки
      </Link>
    </nav>
  )
}
