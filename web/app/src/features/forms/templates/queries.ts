import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { formKeys } from '../keys'
import {
  createFormFromTemplate,
  deleteTemplate,
  listTemplates,
  saveFormAsTemplate,
} from './api'

// Ключи галереи. Пространство входит в ключ обязательно: в ответе лежат свои
// шаблоны этого пространства, и общий ключ показал бы чужие из кэша — тот же
// довод, что у списка форм.
export const templateKeys = {
  all: () => ['templates'] as const,
  list: (workspaceId?: string) => ['templates', 'list', workspaceId ?? null] as const,
}

// Галерея пространства. `enabled` нет: пространство ещё не разрезолвилось —
// спрашиваем витрину без него, она одинакова для всех.
export function useTemplates(workspaceId?: string) {
  return useQuery({
    queryKey: templateKeys.list(workspaceId),
    queryFn: () => listTemplates(workspaceId),
  })
}

// Создание формы из шаблона. Инвалидируется список форм — на дашборде появилась
// новая; галерея не трогается, шаблон использование не меняет.
export function useCreateFormFromTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { templateId: string; workspaceId?: string }) =>
      createFormFromTemplate(vars.templateId, vars.workspaceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: formKeys.list() }),
  })
}

// «Сохранить как шаблон» из меню формы. Инвалидируются ВСЕ галереи разом
// (префикс), а не одна: пространство шаблона задаёт форма, и вызывающий его не
// называет — с дашборда сохраняют форму, про пространство которой экран знает
// только из адреса.
export function useSaveFormAsTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: saveFormAsTemplate,
    onSuccess: () => qc.invalidateQueries({ queryKey: templateKeys.all() }),
  })
}

export function useDeleteTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deleteTemplate,
    onSuccess: () => qc.invalidateQueries({ queryKey: templateKeys.all() }),
  })
}
