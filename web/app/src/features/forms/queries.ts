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
  searchForms,
  publishForm,
  unpublishForm,
  updateBranding,
  updateProgress,
  updateBehavior,
  reopenForm,
  updateNotifyEmail,
  updateNotifyRespondent,
  updateRespondentEmail,
  updateCloseSettings,
  updateCollectPartial,
  updateLinkPreview,
  updateFormName,
  updateFormPassword,
  updateNotifyOnSubmission,
} from './api'
import { saveDraftSchema } from './builder/api'
import {
  type CloseSettingsInput,
  type FormDetail,
  type FormsFilter,
  type FormsSort,
  type BehaviorInput,
  type LinkPreview,
  type NotifyEmail,
  type RespondentEmail,
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
// Поиск по всем пространствам. `enabled` закрыт на пустом запросе: до первой
// набранной буквы спрашивать нечего, а сервер на пустой `q` и так отвечает пустым
// списком — лишний поход к нему просто бесполезен.
//
// staleTime короткий, но не нулевой: пока окно открыто, человек стирает и дописывает
// буквы, возвращаясь к уже набранному, — и повторять запрос за тот же запрос незачем.
export function formsSearchQueryOptions(q: string) {
  const query = q.trim()
  return queryOptions({
    queryKey: formKeys.search(query),
    queryFn: () => searchForms(query),
    enabled: query !== '',
    staleTime: 30 * 1000,
  })
}

export function formsListQueryOptions(params: {
  q: string
  sort: FormsSort
  // status: 'all' означает «без фильтра» (параметр не уходит на сервер).
  status: FormsFilter
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
      status: params.status,
      limit: params.limit,
    }),
    queryFn: ({ pageParam }) =>
      listForms(pageParam, {
        q,
        sort: params.sort,
        status: params.status,
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

// Тумблер сбора незавершённых. Как и уведомления: ответ мутации — карточка формы,
// поэтому свежее значение в detail кладём из отправленного ввода.
export function useUpdateCollectPartial() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; slug: string; enabled: boolean }) =>
      updateCollectPartial(id, enabled),
    onSuccess: (form, { enabled }) => {
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, updatedAt: form.updatedAt, collectPartial: enabled } : old,
      )
    },
  })
}

// Своя карточка ссылки. Как и остальные живые настройки: ответ мутации — карточка
// формы, поэтому свежее значение в detail кладём из отправленного ввода. Пустая
// карточка кладётся как null — ровно тем же значением её отдаст сервер при
// следующем чтении, и «сохранил пустое» не должно выглядеть иначе, чем «не
// настраивал».
export function useUpdateLinkPreview() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, preview }: { id: string; preview: LinkPreview }) =>
      updateLinkPreview(id, preview),
    onSuccess: (form, { preview }) => {
      const stored = Object.values(preview).some((v) => v !== '') ? preview : null
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, updatedAt: form.updatedAt, linkPreview: stored } : old,
      )
    },
  })
}

// Дубликация создаёт новую форму — инвалидируем список, чтобы копия появилась
// сверху (остаёмся на дашборде, в редактор не уходим).
// Экран после отправки — поля СХЕМЫ, а не колонки формы, поэтому правится тем же
// PATCH'ем черновика, что и бейдж: берём схему целиком, подменяем два поля,
// отправляем с `updatedAt` (оптимистичная блокировка — правка мимо редактора
// обязана проиграть чужому автосейву, а не перетереть его молча).
//
// Пустые строки кладутся КАК ЕСТЬ, а не выбрасываются: ровно так их печатает
// `toSchema` стора билдера, и документ, сохранённый отсюда, обязан остаться тем же,
// каким его сохранил бы редактор.
export function useUpdateAfterSubmit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      form,
      thankYouText,
      redirectUrl,
    }: {
      form: FormDetail
      thankYouText: string
      redirectUrl: string
    }) => {
      const draftSchema = { ...form.draftSchema, thankYouText, redirectUrl }
      return saveDraftSchema(form.id, draftSchema, form.updatedAt).then((saved) => ({
        saved,
        draftSchema,
      }))
    },
    onSuccess: ({ saved, draftSchema }) => {
      qc.setQueryData<FormDetail>(formKeys.detail(saved.slug), (old) =>
        old ? { ...old, draftSchema, updatedAt: saved.updatedAt } : old,
      )
    },
  })
}

// Бейдж «Сделано в Trillix» — тумблер с экрана вставки (решение владельца 2026-08-16).
//
// ЖИВОЕ свойство формы, а не поле схемы (ADR §10, миграция 0038): PATCH формы, а не
// сохранение черновика, и на опубликованной форме тумблер срабатывает СРАЗУ —
// перепубликации он не ждёт. Как и остальные живые настройки, ответ мутации — карточка
// формы, поэтому свежее значение в detail кладём из отправленного ввода.
//
// Гейт тарифа (`form_branding`) здесь не проверяется: он на ОТДАЧЕ публичной формы
// (BILLING.md), а намерение автора сохраняется на любом тарифе и срабатывает сразу
// после перехода на платный. Сам контрол на бесплатном плане держит панель.
export function useUpdateBranding() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, show }: { id: string; show: boolean }) => updateBranding(id, show),
    onSuccess: (form, { show }) => {
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, updatedAt: form.updatedAt, branding: show } : old,
      )
    },
  })
}

// Шкала прогресса — тумблер со страницы настроек (миграция 0040). Живое свойство
// формы, как бейдж: PATCH формы, срабатывает без перепубликации, свежее значение в
// detail кладём из отправленного ввода. Гейта тарифа у шкалы нет ни здесь, ни на
// отдаче.
export function useUpdateProgress() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, show }: { id: string; show: boolean }) => updateProgress(id, show),
    onSuccess: (form, { show }) => {
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, updatedAt: form.updatedAt, progress: show } : old,
      )
    },
  })
}

// Тумблер письма респонденту (0046). Включение может упереться в тариф (402
// plan_required): платной здесь является сама отправка, а не свой текст.
export function useUpdateNotifyRespondent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; slug: string; enabled: boolean }) =>
      updateNotifyRespondent(id, enabled),
    onSuccess: (form, { enabled }) => {
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, updatedAt: form.updatedAt, notifyRespondent: enabled } : old,
      )
    },
  })
}

// Пароль на форму (0047). Живая колонка: и постановка, и снятие действуют без
// перепубликации. Тарифа нет — упереться в 402 здесь не во что.
export function useUpdateFormPassword() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, password }: { id: string; password: string | null }) =>
      updateFormPassword(id, password),
    onSuccess: (form, { password }) => {
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, updatedAt: form.updatedAt, password } : old,
      )
    },
  })
}

// Бланк письма респонденту (0046). Как useUpdateNotifyEmail: живое свойство формы,
// пустая настройка хранится как null.
export function useUpdateRespondentEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, value }: { id: string; value: RespondentEmail }) =>
      updateRespondentEmail(id, value),
    onSuccess: (form, { value }) => {
      // Пустота считается ПО СМЫСЛУ полей, а не перебором значений: спаны — массивы,
      // и пустой массив не равен пустой строке.
      const empty =
        value.sourceBlockId === '' &&
        value.fromName === '' &&
        value.replyTo === '' &&
        value.subject.length === 0 &&
        value.body.length === 0 &&
        !value.attachPdf
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, updatedAt: form.updatedAt, respondentEmail: empty ? null : value } : old,
      )
    },
  })
}

// Настройка письма о новом ответе (0042).// Настройка письма о новом ответе (0042). Живое свойство формы: PATCH формы,
// применяется со следующего же ответа. Пустая настройка приходит с сервера как null
// — кладём в кэш именно её, а не объект из пустых строк.
export function useUpdateNotifyEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, value }: { id: string; value: NotifyEmail }) => updateNotifyEmail(id, value),
    onSuccess: (form, { value }) => {
      const stored = Object.values(value).some((v) => v !== '') ? value : null
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, updatedAt: form.updatedAt, notifyEmail: stored } : old,
      )
    },
  })
}

// Раздел «Поведение» (0044). Живые колонки: применяется со следующего же открытия
// формы, без перепубликации.
export function useUpdateBehavior() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, behavior }: { id: string; behavior: BehaviorInput }) =>
      updateBehavior(id, behavior),
    onSuccess: (form, { behavior }) => {
      qc.setQueryData<FormDetail>(formKeys.detail(form.slug), (old) =>
        old ? { ...old, updatedAt: form.updatedAt, ...behavior } : old,
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

// Повторное открытие закрытой формы. Ответ — карточка формы: раскладываем её в
// деталь целиком (как unpublish), меняется статус, а не отдельное поле.
export function useReopenForm() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => reopenForm(id),
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
