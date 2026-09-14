import { useEffect, useMemo, useRef } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { type Form, type FormDetail } from '../../entities/form'
import { createForm } from '../../features/forms/api'
import { newFormDetail, useFormEditorTarget } from '../../features/forms/draft'
import { formKeys } from '../../features/forms/keys'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { type DraftCreation } from '../../features/forms/builder/useAutosave'
import { BuilderScreen } from '../../features/forms/builder/BuilderScreen'
import { resolveWorkspaceId, useCurrentWorkspace } from '../../features/workspaces/current'
import { useWorkspaceCrumb } from '../../features/workspaces/crumb'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'

// Редактор формы (/forms/$slug/edit): грузит форму по slug через Query и отдаёт
// билдеру. Вся навигация/публикация — в шапке BuilderScreen; название правится
// первой строкой полотна. Здесь только загрузка/ошибка и чистое полотно во всю ширину.
//
// Тот же маршрут обслуживает ЕЩЁ НЕ СОЗДАННЫЙ черновик (/forms/new/edit): формы на
// сервере нет, пока автор не внёс ни одной правки (features/forms/draft.ts), и первая
// правка заводит её отсюда — POST /forms, а следом замена сентинела в адресе на
// настоящий slug.
export const Route = createFileRoute('/_app/w/$workspaceSlug/forms/$slug/edit')({
  component: FormEditor,
})

function FormEditor() {
  const { slug, workspaceSlug } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  // Черновик несозданной формы, ключ полотна и приём созданной карточки — всё в
  // features/forms/draft.ts: маршрут у черновика и у настоящей формы один, и правило
  // «когда экран начинается заново» там же и проверяется тестом.
  const { draftDetail, isDraft, canvasKey, adoptCreated } = useFormEditorTarget(slug, workspaceSlug)

  // Запрос черновику не нужен: спрашивать нечего, пока формы нет. После создания он
  // остаётся выключенным, но данные отдаёт — их кладёт в кэш onCreated, а дальше
  // двигает автосейв (бейдж «есть изменения», токен блокировки).
  const query = useQuery({ ...formDetailQueryOptions(slug), enabled: !isDraft })

  // ⚠ У ТОЛЬКО ЧТО СОЗДАННОЙ ФОРМЫ В КЭШЕ НЕТ ПРОСТРАНСТВА, и это не мелочь.
  //
  // Деталь такой формы собирается из ответа `POST /forms` (onCreated ниже), а он —
  // короткая карточка: ни workspaceId, ни workspaceSlug в ней нет, и остаются
  // дефолты синтетической детали, то есть пустые строки. Запрос детали при этом
  // выключен (форма «черновик» до конца сеанса), поэтому сами они не приедут.
  //
  // Видно это было ровно в одном месте и молча: попап блока «Запись» спрашивает
  // расписания ПРОСТРАНСТВА формы, с пустым id запрос не включался, и автор видел
  // пустой список — при заведённом расписании (отчёт владельца 2026-09-03).
  //
  // Достраиваем пространством ИЗ ПУТИ: для новой формы это верно по построению — она
  // заводится ровно туда, куда указывает адрес. У существующей поле уже пришло с
  // сервера и не трогается.
  const workspace = useCurrentWorkspace()
  const workspaceCrumb = useWorkspaceCrumb()
  const detail = useMemo(() => {
    const base = query.data ?? draftDetail
    if (!base || base.workspaceId !== '' || !workspace) return base
    return { ...base, workspaceId: workspace.id, workspaceSlug: workspace.slug }
  }, [query.data, draftDetail, workspace])

  // Адрес и форма разошлись — верим ФОРМЕ и правим адрес. Разойтись они могут только
  // от правки адреса руками: ссылки кабинета строятся из `form.workspaceSlug`. Без
  // этой правки экран работал бы верно (права и данные проверяются по членству на
  // бэке), но сайдбар подсвечивал бы чужое пространство, а крошка называла бы его.
  const formWorkspace = query.data?.workspaceSlug
  useEffect(() => {
    if (!formWorkspace || formWorkspace === workspaceSlug) return
    void navigate({
      to: '/w/$workspaceSlug/forms/$slug/edit',
      params: { workspaceSlug: formWorkspace, slug },
      replace: true,
    })
  }, [formWorkspace, workspaceSlug, slug, navigate])

  // Живость экрана: сохранение досылается на размонтировании (useAutosave), и форма
  // может родиться уже после ухода автора с полотна. Кэш обновить в этот момент
  // правильно, а вот утащить человека в редактор — нет.
  //
  // МИНА: живость обязана ВЗВОДИТЬСЯ в теле эффекта, а не только гаситься в уборке.
  // React в StrictMode прогоняет эффект дважды (монтирование → уборка → монтирование),
  // и без первой строки флаг оставался бы false навсегда — то есть в dev-сборке
  // переход после создания формы не случался бы вовсе.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => void (alive.current = false)
  }, [])

  const draft: DraftCreation | undefined = isDraft
    ? {
        create: async () => createForm(undefined, await resolveWorkspaceId(qc, workspaceSlug)),
        onCreated: (form: Form) => {
          // Карточка пришла в ответе, остальное у новой формы дефолтное (тот же
          // источник, что и у синтетической детали). Запись в кэш обязательна: из
          // него автосейв берёт токен оптимистичной блокировки, и без неё второй
          // PATCH ушёл бы с устаревшим updatedAt — 409 на ровном месте.
          const created: FormDetail = { ...newFormDetail(), ...form }
          qc.setQueryData(formKeys.detail(form.slug), created)
          adoptCreated(created)
          qc.invalidateQueries({ queryKey: formKeys.list() })
          // Адрес догоняет форму, ЗАМЕНЯЯ запись истории: «Назад» обязан вести туда,
          // откуда человек пришёл, а не на пустой /forms/new. Полотно при этом не
          // перемонтируется: маршрут тот же, а созданную форму мишень экрана уже
          // приняла своей (useFormEditorTarget) — ключ стора не дрогнет.
          if (alive.current) {
            void navigate({
              to: '/w/$workspaceSlug/forms/$slug/edit',
              params: { workspaceSlug, slug: form.slug },
              replace: true,
            })
          }
        },
      }
    : undefined

  // Состояния ДО полотна — страница кабинета: колонка, крошки и примитивы отказа и
  // загрузки, как у оболочки экранов формы (`forms.$slug._manage.tsx`).
  if (!detail) {
    return (
      <PageContainer>
        <PageCrumbs items={[workspaceCrumb, 'Форма']} />
        {query.isError ? (
          <>
            <ErrorState
              title="Форма не найдена."
              description="Возможно, её удалили или ссылка устарела."
            />
            <Button asChild variant="outline" size="sm" className="mt-4">
              <Link to="/w/$workspaceSlug/forms" params={{ workspaceSlug }}>
                Вернуться к списку
              </Link>
            </Button>
          </>
        ) : (
          <LoadingRows />
        )}
      </PageContainer>
    )
  }

  // Свежий стор билдера на каждую форму; у черновика ключ заморожен (см. хук).
  return <BuilderScreen key={canvasKey} detail={detail} draft={draft} />
}
