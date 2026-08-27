import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { formDetailQueryOptions } from '../../features/forms/queries'
import { FormSettingsView } from '../../features/forms/settings/FormSettingsView'
import { LoadingRows } from '../../shared/page/states'

// Таб «Настройки» (/forms/$slug/settings): то, чего на полотне не видно — экран
// после отправки, закрытие приёма, письма, сбор незавершённых.
//
// Раздел формы, а не режим редактора (решение владельца 2026-08-26): у настроек
// появился адрес, и на них можно послать ссылкой — этим и пользуется вкладка
// «Частичные». Ошибку «формы нет» рисует оболочка _manage, здесь остаётся загрузка.
export const Route = createFileRoute('/_app/forms/$slug/_manage/settings')({
  component: FormSettingsPage,
})

function FormSettingsPage() {
  const { slug } = Route.useParams()
  const form = useQuery(formDetailQueryOptions(slug))

  if (!form.data) return <LoadingRows rows={4} />
  return <FormSettingsView form={form.data} />
}
