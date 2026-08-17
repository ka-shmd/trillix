import { useMutation, useQueryClient } from '@tanstack/react-query'

import { formKeys } from '../keys'
import { createForm } from '../api'
import { saveDraftSchema } from '../builder/api'
import { type FormTemplate, buildTemplateSchema } from './templates'

// Создание формы из шаблона — два запроса подряд: пустая форма, затем её черновик.
// Ручки «создать сразу со схемой» нет и заводить её ради галереи незачем: PATCH
// черновика — тот же путь, которым схему пишет автосейв редактора, и заголовок формы
// приезжает вместе с документом (блок form_title, зеркало в forms.title считает
// сервер).
//
// Промежуточное состояние — пустая форма в списке — переживаемо: сорвись второй запрос,
// автор увидит на дашборде свежую пустую форму, а не потеряет заготовку молча.
export function useCreateFormFromTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (vars: { template: FormTemplate; workspaceId?: string }) => {
      const form = await createForm(undefined, vars.workspaceId)
      return saveDraftSchema(form.id, buildTemplateSchema(vars.template), form.updatedAt)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: formKeys.list() }),
  })
}
