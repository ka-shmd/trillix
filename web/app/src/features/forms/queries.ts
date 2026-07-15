import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { formKeys } from './keys'
import {
  createForm,
  deleteForm,
  duplicateForm,
  getForm,
  listForms,
  publishForm,
  renameForm,
  unpublishForm,
  updateFormName,
} from './api'
import { type Form, type FormDetail } from '../../entities/form'

// Список форм — серверный стейт с курсорной пагинацией: страницы подгружаются
// через getNextPageParam, курсор непрозрачен для клиента.
export const formsListQueryOptions = infiniteQueryOptions({
  queryKey: formKeys.list(),
  queryFn: ({ pageParam }) => listForms(pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
})

export function formDetailQueryOptions(id: string) {
  return queryOptions({
    queryKey: formKeys.detail(id),
    queryFn: () => getForm(id),
  })
}

// Все мутации инвалидируют список (web/CLAUDE.md: забытая инвалидация — баг).

export function useCreateForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (title?: string) => createForm(title),
    onSuccess: () => qc.invalidateQueries({ queryKey: formKeys.list() }),
  })
}

// Переименование двигает forms.updated_at на сервере. Патчим detail в кэше (title +
// новый updatedAt), а не инвалидируем: билдер держит updated_at как токен
// оптимистичной блокировки автосейва (formLockToken) — синхронный патч не даёт
// следующему PATCH схемы уйти со старым токеном и словить 409. Рефетч тут был бы
// гонкой с автосейвом. Спредить весь form нельзя: у ответа мутации
// hasUnpublishedChanges/submissionCount заглушечные (false/0) — берём только title и
// updatedAt, остальное в detail не меняется переименованием. draftSchema сохраняется.
export function renameDetailPatch(form: Form) {
  return (old: FormDetail | undefined): FormDetail | undefined =>
    old ? { ...old, title: form.title, updatedAt: form.updatedAt } : old
}

export function useRenameForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameForm(id, title),
    onSuccess: (form) => {
      qc.invalidateQueries({ queryKey: formKeys.list() })
      qc.setQueryData<FormDetail>(formKeys.detail(form.id), renameDetailPatch(form))
    },
  })
}

// Переименование внутреннего имени (дашборд). Как и rename заголовка, двигает
// updated_at — патчим detail (name + updatedAt), чтобы не словить 409 автосейва.
export function useUpdateFormName() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => updateFormName(id, name),
    onSuccess: (form) => {
      qc.invalidateQueries({ queryKey: formKeys.list() })
      qc.setQueryData<FormDetail>(formKeys.detail(form.id), (old) =>
        old ? { ...old, name: form.name, updatedAt: form.updatedAt } : old,
      )
    },
  })
}

// Дубликация создаёт новую форму — инвалидируем список, чтобы копия появилась
// сверху (остаёмся на дашборде, в редактор не уходим).
export function useDuplicateForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => duplicateForm(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: formKeys.list() }),
  })
}

export function useDeleteForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteForm(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: formKeys.list() }),
  })
}

// Публикация/снятие патчат detail возвращённой формой (status, версия,
// hasUnpublishedChanges=false), сохраняя draftSchema из кэша — билдер не
// перегидрируется. Список инвалидируется (статус на карточке).

export function usePublishForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => publishForm(id),
    onSuccess: (form) => {
      qc.invalidateQueries({ queryKey: formKeys.list() })
      qc.setQueryData<FormDetail>(formKeys.detail(form.id), (old) =>
        old ? { ...old, ...form } : old,
      )
    },
  })
}

export function useUnpublishForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => unpublishForm(id),
    onSuccess: (form) => {
      qc.invalidateQueries({ queryKey: formKeys.list() })
      qc.setQueryData<FormDetail>(formKeys.detail(form.id), (old) =>
        old ? { ...old, ...form } : old,
      )
    },
  })
}
