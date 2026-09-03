import { apiRequest } from '../../shared/api/client'
import {
  formSchema,
  formDetailSchema,
  formsPageSchema,
  type CloseSettingsInput,
  type Form,
  type FormDetail,
  type FormsPage,
  type FormsSort,
  type BehaviorInput,
  type LinkPreview,
  type NotifyEmail,
  type RespondentEmail,
} from '../../entities/form'

// Транспорт forms: каждый ответ парсится Zod-схемой на границе; delete — 204 без тела.

// listForms — страница списка. q — поиск по отображаемому имени (name ?? title),
// sort — порядок; курсор непрозрачен и несёт в себе порядок, которым выдан,
// поэтому листать с ним другую сортировку сервер не даст (422).
// workspaceId — в каком пространстве смотрим; не передан = личное (сервер
// подставляет его сам, поэтому старые ссылки без параметра работают как раньше).
// limit — размер страницы; не передан = умолчание сервера.
export function listForms(
  cursor?: string,
  opts?: { q?: string; sort?: FormsSort; workspaceId?: string; limit?: number },
): Promise<FormsPage> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  if (opts?.q) params.set('q', opts.q)
  if (opts?.sort && opts.sort !== 'updated') params.set('sort', opts.sort)
  if (opts?.workspaceId) params.set('workspaceId', opts.workspaceId)
  // limit не передан = размер страницы сервера (forms.DefaultPageLimit); свой
  // сервер зажимает в [1, MaxPageLimit].
  if (opts?.limit) params.set('limit', String(opts.limit))
  const query = params.toString()
  return apiRequest(`/forms${query ? `?${query}` : ''}`, { schema: formsPageSchema })
}

// Форма по slug: URL кабинета (редактор/ответы/шаринг) адресует форму коротким
// slug, как публичный рендерер /r/{slug}, а не UUID. UUID для последующих мутаций
// берётся из ответа (form.id). slug — в query (путь /forms/by-slug/{slug}
// конфликтовал бы с /forms/{id}/submissions).
export function getFormBySlug(slug: string): Promise<FormDetail> {
  return apiRequest(`/forms/lookup?slug=${encodeURIComponent(slug)}`, {
    schema: formDetailSchema,
  })
}

export function createForm(title?: string, workspaceId?: string): Promise<Form> {
  return apiRequest('/forms', {
    method: 'POST',
    body: {
      ...(title ? { title } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    },
    schema: formSchema,
  })
}

// Переименование ВНУТРЕННЕГО имени (дашборд). Не трогает публичный заголовок; пустая
// строка сбрасывает имя (кабинет снова показывает заголовок). См. ADR §10.
export function updateFormName(id: string, name: string): Promise<Form> {
  return apiRequest(`/forms/${id}`, { method: 'PATCH', body: { name }, schema: formSchema })
}

// Настройки закрытия формы (фаза 8.5 шаг 4): дата, лимит, текст «приём закрыт».
// Фасет closeSettings PATCH заменяет все три колонки разом. Ответ — карточка формы
// (закрытие живёт в колонках, публикации не требует); свежие настройки берутся
// перечитыванием детали.
export function updateCloseSettings(id: string, settings: CloseSettingsInput): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { closeSettings: settings },
    schema: formSchema,
  })
}

// Тумблер уведомлений владельцу о новом ответе (слайс D). Как closeSettings: ответ —
// карточка формы, свежее значение фронт берёт перечитыванием детали.
export function updateNotifyOnSubmission(id: string, enabled: boolean): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { notifyOnSubmission: enabled },
    schema: formSchema,
  })
}

// Тумблер сбора незавершённых ответов. Включение может упереться в тариф (402
// plan_required) — вызывающий показывает плашку, а не молча оставляет выключенным.
export function updateCollectPartial(id: string, enabled: boolean): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { collectPartial: enabled },
    schema: formSchema,
  })
}

// Настройка письма о новом ответе (фасет notifyEmail): имя отправителя, Reply-To,
// тема, текст. 402 здесь БЫВАЕТ — настройка платная, и бэк отвергает правку, которую
// кабинет на бесплатном плане и так не даёт сделать. Сброс (все поля пустые) проходит
// на любом тарифе: вернуться к дефолтному письму вправе каждый.
export function updateNotifyEmail(id: string, value: NotifyEmail): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { notifyEmail: value },
    schema: formSchema,
  })
}

// Тумблер письма респонденту (фасет notifyRespondent). 402 бывает на ВКЛЮЧЕНИИ:
// платной здесь является сама отправка, а не свой текст. Выключение проходит на
// любом тарифе — даунгрейд не запирает автора в рассылке.
export function updateNotifyRespondent(id: string, enabled: boolean): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { notifyRespondent: enabled },
    schema: formSchema,
  })
}

// Бланк письма респонденту (фасет respondentEmail): вопрос-источник адреса, имя
// отправителя, Reply-To, тема, текст, PDF. Гейт и сброс — как у notifyEmail.
export function updateRespondentEmail(id: string, value: RespondentEmail): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { respondentEmail: value },
    schema: formSchema,
  })
}

// Пароль на форму (фасет password). Обёртка вокруг value отличает «снять» (null) от
// «не трогать» (фасета нет вовсе): у голого поля отсутствие и явный null были бы
// неразличимы. Тарифа у пароля нет — 402 здесь не бывает.
export function updateFormPassword(id: string, password: string | null): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { password: { value: password } },
    schema: formSchema,
  })
}

// Расписание записи у формы (фасет schedule). Обёртка вокруг value — по той же
// причине, что у пароля: null значит «снять запись», а отсутствие фасета — «не
// трогать». Чужое расписание сервер отвергнет 404 (проверка пространства).
export function setFormSchedule(id: string, scheduleId: string | null): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { schedule: { value: scheduleId } },
    schema: formSchema,
  })
}

// Раздел «Поведение» (фасет behavior): автопереход и хранение ответов в браузере
// респондента. Набором, а не по тумблеру: это один раздел экрана. Гейта нет.
export function updateBehavior(id: string, behavior: BehaviorInput): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { behavior },
    schema: formSchema,
  })
}

// Тумблер шкалы прогресса (фасет progress): true = показывать индикатор шагов.
// Гейта нет ни здесь, ни на отдаче — шкала открыта всем тарифам.
// Повторное открытие закрытой формы: status='published' БЕЗ новой версии. Отдельная
// ручка, а не публикация: та подняла бы номер версии, ничего не изменив в документе.
export function reopenForm(id: string): Promise<Form> {
  return apiRequest(`/forms/${id}/reopen`, { method: 'POST', schema: formSchema })
}

export function updateProgress(id: string, show: boolean): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { progress: show },
    schema: formSchema,
  })
}

// Тумблер бейджа «Сделано в Trillix» (фасет branding): true = показывать. 402 здесь
// НЕ бывает — намерение сохраняется на любом тарифе, а сработает ли оно, решает
// отдача публичной формы. Контрол на бесплатном плане держит сам кабинет.
export function updateBranding(id: string, show: boolean): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { branding: show },
    schema: formSchema,
  })
}

// Своя карточка ссылки (фасет linkPreview): заменяет карточку целиком, пустое поле
// = вернуть дефолт. 402 здесь НЕ бывает — сохранять карточку вправе любой тариф, а
// применяется она к публичной ссылке только на разрешённом плане.
export function updateLinkPreview(id: string, preview: LinkPreview): Promise<Form> {
  return apiRequest(`/forms/${id}`, {
    method: 'PATCH',
    body: { linkPreview: preview },
    schema: formSchema,
  })
}

// Дубликация: копия формы «{название} (копия)» с тем же черновиком, всегда draft.
export function duplicateForm(id: string): Promise<Form> {
  return apiRequest(`/forms/${id}/duplicate`, { method: 'POST', schema: formSchema })
}

export function deleteForm(id: string): Promise<void> {
  return apiRequest(`/forms/${id}`, { method: 'DELETE' })
}

// Публикация: снимок черновика в новую версию, форма становится published.
export function publishForm(id: string): Promise<Form> {
  return apiRequest(`/forms/${id}/publish`, { method: 'POST', schema: formSchema })
}

// Снятие с публикации: форма становится closed (последняя версия сохраняется).
export function unpublishForm(id: string): Promise<Form> {
  return apiRequest(`/forms/${id}/unpublish`, { method: 'POST', schema: formSchema })
}
