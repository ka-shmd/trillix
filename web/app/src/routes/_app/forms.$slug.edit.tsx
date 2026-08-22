import { useEffect, useRef, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { type Form, type FormDetail } from '../../entities/form'
import { createForm } from '../../features/forms/api'
import { NEW_FORM_SLUG, newFormDetail } from '../../features/forms/draft'
import { formKeys } from '../../features/forms/keys'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { type DraftCreation } from '../../features/forms/builder/useAutosave'
import { BuilderScreen } from '../../features/forms/builder/BuilderScreen'
import { useCurrentWorkspaceId } from '../../shared/currentWorkspace'
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
  // Пространство, в котором заводить форму, берётся из адреса (пусто = личное) — тем
  // же способом, каким его читает кнопка «Новая форма», приведшая сюда.
  const workspaceId = useCurrentWorkspaceId()

  // Черновик несозданной формы. Решение «это черновик» принимается ОДИН раз, на
  // монтировании: создание меняет slug в адресе, и перечитанный параметр увёл бы
  // экран в ветку обычной формы. Дальше состояние живёт только вперёд — деталь
  // заменяется настоящей карточкой, но экран остаётся тем же.
  const [draftDetail, setDraftDetail] = useState<FormDetail | null>(() =>
    slug === NEW_FORM_SLUG ? newFormDetail() : null,
  )
  const isDraft = draftDetail !== null

  // Запрос черновику не нужен: спрашивать нечего, пока формы нет. После создания он
  // остаётся выключенным, но данные отдаёт — их кладёт в кэш onCreated, а дальше
  // двигает автосейв (бейдж «есть изменения», токен блокировки).
  const query = useQuery({ ...formDetailQueryOptions(slug), enabled: !isDraft })
  const detail = query.data ?? draftDetail

  // Живость экрана: сохранение досылается на размонтировании (useAutosave), и форма
  // может родиться уже после ухода автора с полотна. Кэш обновить в этот момент
  // правильно, а вот утащить человека в редактор — нет.
  const alive = useRef(true)
  useEffect(() => () => void (alive.current = false), [])

  const draft: DraftCreation | undefined = isDraft
    ? {
        create: () => createForm(undefined, workspaceId || undefined),
        onCreated: (form: Form) => {
          // Карточка пришла в ответе, остальное у новой формы дефолтное (тот же
          // источник, что и у синтетической детали). Запись в кэш обязательна: из
          // него автосейв берёт токен оптимистичной блокировки, и без неё второй
          // PATCH ушёл бы с устаревшим updatedAt — 409 на ровном месте.
          const created: FormDetail = { ...newFormDetail(), ...form }
          qc.setQueryData(formKeys.detail(form.slug), created)
          setDraftDetail(created)
          qc.invalidateQueries({ queryKey: formKeys.list() })
          // Адрес догоняет форму, ЗАМЕНЯЯ запись истории: «Назад» обязан вести туда,
          // откуда человек пришёл, а не на пустой /forms/new. Полотно при этом не
          // перемонтируется — маршрут тот же, ключ стора заморожен (ниже).
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

  // key={slug} — свежий стор билдера на каждую форму. У черновика ключ ЗАМОРОЖЕН на
  // сентинеле: создание формы меняет slug, и ключ по нему ремаунтил бы полотно прямо
  // под кареткой автора, дописывающего первое слово.
  return <BuilderScreen key={isDraft ? NEW_FORM_SLUG : slug} detail={detail} draft={draft} />
}
