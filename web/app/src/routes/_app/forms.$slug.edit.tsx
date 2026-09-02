import { useEffect, useRef } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { type Form, type FormDetail } from '../../entities/form'
import { createForm } from '../../features/forms/api'
import { newFormDetail, useFormEditorTarget } from '../../features/forms/draft'
import { formKeys } from '../../features/forms/keys'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { type DraftCreation } from '../../features/forms/builder/useAutosave'
import { BuilderScreen } from '../../features/forms/builder/BuilderScreen'
import { resolveWorkspaceId } from '../../features/workspaces/current'
import { useCurrentWorkspaceSlug } from '../../shared/currentWorkspace'
import { Button } from '@/components/ui/button'

// Редактор формы (/forms/$slug/edit): грузит форму по slug через Query и отдаёт
// билдеру. Вся навигация/публикация — в шапке BuilderScreen; название правится
// первой строкой полотна. Здесь только загрузка/ошибка и чистое полотно во всю ширину.
//
// Тот же маршрут обслуживает ЕЩЁ НЕ СОЗДАННЫЙ черновик (/forms/new/edit): формы на
// сервере нет, пока автор не внёс ни одной правки (features/forms/draft.ts), и первая
// правка заводит её отсюда — POST /forms, а следом замена сентинела в адресе на
// настоящий slug.
export const Route = createFileRoute('/_app/forms/$slug/edit')({
  component: FormEditor,
})

function FormEditor() {
  const { slug } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  // Пространство, в котором заводить форму, берётся из адреса (?w=<slug>, пусто =
  // личное) — тем же способом, каким его читает кнопка «Новая форма», приведшая
  // сюда. Из адреса берётся SLUG, а `POST /forms` ждёт id: перевод делается в
  // момент создания (resolveWorkspaceId), а не на рендере — см. мину там.
  const workspaceSlug = useCurrentWorkspaceSlug()

  // Черновик несозданной формы, ключ полотна и приём созданной карточки — всё в
  // features/forms/draft.ts: маршрут у черновика и у настоящей формы один, и правило
  // «когда экран начинается заново» там же и проверяется тестом.
  const { draftDetail, isDraft, canvasKey, adoptCreated } = useFormEditorTarget(
    slug,
    workspaceSlug,
  )

  // Запрос черновику не нужен: спрашивать нечего, пока формы нет. После создания он
  // остаётся выключенным, но данные отдаёт — их кладёт в кэш onCreated, а дальше
  // двигает автосейв (бейдж «есть изменения», токен блокировки).
  const query = useQuery({ ...formDetailQueryOptions(slug), enabled: !isDraft })
  const detail = query.data ?? draftDetail

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
              to: '/forms/$slug/edit',
              params: { slug: form.slug },
              search: (prev) => prev,
              replace: true,
            })
          }
        },
      }
    : undefined

  if (!detail) {
    if (query.isError) {
      return (
        <div role="alert" className="m-6 rounded-lg border border-destructive/40 bg-destructive/5 p-6">
          <p className="mb-3 text-sm">Форма не найдена.</p>
          <Button asChild variant="outline" size="sm">
            <Link to="/forms" search={(prev) => prev}>Вернуться к списку</Link>
          </Button>
        </div>
      )
    }
    return <p className="p-6 text-sm text-muted-foreground">Загрузка…</p>
  }

  // Свежий стор билдера на каждую форму; у черновика ключ заморожен (см. хук).
  return <BuilderScreen key={canvasKey} detail={detail} draft={draft} />
}
