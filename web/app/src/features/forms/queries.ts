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
  getFormBySlug,
  listForms,
  publishForm,
  renameForm,
  unpublishForm,
  updateCloseSettings,
  updateFormName,
} from './api'
import {
  type CloseSettingsInput,
  type Form,
  type FormDetail,
  type FormsSort,
} from '../../entities/form'

// Список форм — серверный стейт с курсорной пагинацией: страницы подгружаются
// через getNextPageParam, курсор непрозрачен для клиента.
//
// Поиск и сортировка входят в query-ключ, а не фильтруют уже загруженное:
// фильтровать на клиенте можно только то, что целиком в кэше, а список
// постраничный — «поиск» показывал бы совпадения из подгруженных страниц и молча
// терял остальные. Смена параметров = другой ключ = листание с первой страницы,
// что заодно снимает риск уехать курсором прежней сортировки (сервер такой курсор
// отвергает).
export function formsListQueryOptions(params: { q: string; sort: FormsSort }) {
  // Пробелы по краям сервер всё равно срезает, поэтому нормализуем и здесь: иначе
  // « анкета » и «анкета» — две записи кэша с заведомо одинаковым содержимым.
  const q = params.q.trim()
  return infiniteQueryOptions({
    queryKey: formKeys.listWith({ q, sort: params.sort }),
    queryFn: ({ pageParam }) => listForms(pageParam, { q, sort: params.sort }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })
}

// Detail адресуется slug'ом (ключ URL кабинета), а не UUID: кэш detail всюду
// ключуется slug'ом — мутации патчат его по form.slug, автосейв читает токен по
// slug. UUID формы (form.id) внутри detail используется для самих API-вызовов.
export function formDetailQueryOptions(slug: string) {
  return queryOptions({
    queryKey: formKeys.detail(slug),
    queryFn: () => getFormBySlug(slug),
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
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), renameDetailPatch(form))
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
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, name: form.name, updatedAt: form.updatedAt } : old,
      )
    },
  })
}

// Настройки закрытия (фаза 8.5 шаг 4) сохраняются со страницы настроек билдера,
// поэтому — как rename — двигают forms.updated_at и патчат detail (а не
// инвалидируют): updated_at служит токеном оптимистичной блокировки автосейва,
// рефетч дал бы гонку. Ответ мутации — карточка (без close-полей), поэтому close-
// настройки в detail кладём из отправленного ввода, а updatedAt — из ответа. Пустой
// текст нормализуем в null (как бэкенд: пусто = дефолт рендерера).
export function useUpdateCloseSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, settings }: { id: string; settings: CloseSettingsInput }) =>
      updateCloseSettings(id, settings),
    onSuccess: (form, { settings }) => {
      qc.invalidateQueries({ queryKey: formKeys.list() })
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old
          ? {
              ...old,
              updatedAt: form.updatedAt,
              closeAt: settings.closeAt,
              responseLimit: settings.responseLimit,
              closedMessage: settings.closedMessage === '' ? null : settings.closedMessage,
            }
          : old,
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
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
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
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, ...form } : old,
      )
    },
  })
}
