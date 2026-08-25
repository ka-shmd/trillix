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
