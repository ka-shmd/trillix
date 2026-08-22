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
  unpublishForm,
  updateCloseSettings,
  updateFormName,
  updateNotifyOnSubmission,
} from './api'
import { saveDraftSchema } from './builder/api'
import {
  type CloseSettingsInput,
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
export function formsListQueryOptions(params: {
  q: string
  sort: FormsSort
  // workspaceId: '' означает личное пространство (параметр не уходит на сервер).
  workspaceId: string
  // limit — размер страницы; не задан = умолчание сервера (50). Обзор пространств
  // просит короткие страницы: под каждым пространством видно первую десятку.
  limit?: number
}) {
  // Пробелы по краям сервер всё равно срезает, поэтому нормализуем и здесь: иначе
  // « анкета » и «анкета» — две записи кэша с заведомо одинаковым содержимым.
  const q = params.q.trim()
  return infiniteQueryOptions({
    queryKey: formKeys.listWith({
      workspaceId: params.workspaceId,
      q,
      sort: params.sort,
      limit: params.limit,
    }),
    queryFn: ({ pageParam }) =>
      listForms(pageParam, {
        q,
        sort: params.sort,
        workspaceId: params.workspaceId || undefined,
        limit: params.limit,
      }),
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

// workspaceId — куда кладём форму; пусто = личное пространство.
export function useCreateForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { title?: string; workspaceId?: string } | undefined) =>
      createForm(vars?.title, vars?.workspaceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: formKeys.list() }),
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

// Тумблер уведомлений (слайс D). Ответ мутации — карточка (без notify-поля),
// поэтому свежее значение в detail кладём из отправленного ввода, updatedAt — из
// ответа (как useUpdateCloseSettings).
export function useUpdateNotifyOnSubmission() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; slug: string; enabled: boolean }) =>
      updateNotifyOnSubmission(id, enabled),
    onSuccess: (form, { enabled }) => {
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, updatedAt: form.updatedAt, notifyOnSubmission: enabled } : old,
      )
    },
  })
}

// Дубликация создаёт новую форму — инвалидируем список, чтобы копия появилась
// сверху (остаёмся на дашборде, в редактор не уходим).
/**
 * Бейдж «Сделано в Trillix» — с экрана вставки (решение владельца 2026-08-16).
 *
 * Правит ЧЕРНОВИК формы тем же PATCH'ем схемы, что автосейв билдера: бейдж — свойство
 * оформления, а не вставки, и настройка одна на все вставки и на прямую ссылку. На
 * живой форме сработает после публикации (схема снапшотится) — экран говорит об этом
 * строкой рядом.
 *
 * Гейт тарифа (`form_branding`) здесь не проверяется: он на ОТДАЧЕ публичной формы
 * (BILLING.md), а намерение автора сохраняется на любом тарифе и срабатывает сразу
 * после перехода на платный. Панель предупреждает словами, как это делала шторка.
 */
export function useUpdateBranding() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ form, show }: { form: FormDetail; show: boolean }) => {
      const design = { ...(form.draftSchema.design ?? {}) }
      // «Показывать» — ОТСУТСТВИЕ ключа: второго представления у этого состояния нет,
      // того же требует валидатор (`design.branding` принимает только false).
      if (show) delete design.branding
      else design.branding = false
      const draftSchema = {
        ...form.draftSchema,
        design: Object.keys(design).length > 0 ? design : undefined,
      }
      return saveDraftSchema(form.id, draftSchema, form.updatedAt).then((saved) => ({
        saved,
        draftSchema,
      }))
    },
    onSuccess: ({ saved, draftSchema }) => {
      qc.invalidateQueries({ queryKey: formKeys.list() })
      qc.setQueryData<FormDetail>(formKeys.detail(saved.slug), (old) =>
        old ? { ...old, draftSchema, updatedAt: saved.updatedAt } : old,
      )
    },
  })
}

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
