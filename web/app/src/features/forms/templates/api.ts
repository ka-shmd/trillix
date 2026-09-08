import { createdFormSchema, type CreatedForm } from '../../../entities/form'
import {
  type FormTemplate,
  formTemplateSchema,
  templatesResponseSchema,
} from '../../../entities/template'
import { apiRequest } from '../../../shared/api/client'

// Транспорт шаблонов: каждый ответ парсится Zod-схемой на границе; удаление —
// 204 без тела.

// listTemplates — галерея одним запросом: публичные шаблоны плюс свои, если
// названо пространство. Одной ручкой, а не двумя, потому что галерея всегда
// рисует обе вкладки разом — две загрузки на одном экране означали бы, что он
// может показаться наполовину.
export function listTemplates(workspaceId?: string): Promise<{ items: FormTemplate[] }> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
  return apiRequest(`/templates${query}`, { schema: templatesResponseSchema })
}

// saveFormAsTemplate — «Сохранить как шаблон» из меню формы. Пустое название
// означает «как у формы»; пространство не передаётся вовсе — шаблон ложится туда,
// где лежит сама форма.
export function saveFormAsTemplate(params: {
  formId: string
  title: string
  description: string
}): Promise<FormTemplate> {
  return apiRequest('/templates', {
    method: 'POST',
    body: params,
    schema: formTemplateSchema,
  })
}

// createFormFromTemplate — форма из шаблона ОДНИМ запросом. Прежняя пара
// «POST /forms + PATCH черновика» оставляла на дашборде пустую форму, если
// второй запрос срывался.
//
// Ответ — только id, slug и title: у свежей формы счётчики и публикация пусты по
// определению. Кабинету нужен slug — им адресуется редактор.
export function createFormFromTemplate(
  templateId: string,
  workspaceId?: string,
): Promise<CreatedForm> {
  return apiRequest(`/templates/${templateId}/use`, {
    method: 'POST',
    body: workspaceId ? { workspaceId } : {},
    schema: createdFormSchema,
  })
}

export function deleteTemplate(id: string): Promise<void> {
  return apiRequest(`/templates/${id}`, { method: 'DELETE' })
}
