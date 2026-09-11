import { useQuery, useQueryClient } from '@tanstack/react-query'

import { formKeys } from '../../keys'
import { setFormSchedule } from '../../api'
import { schedulesQueryOptions } from '../../../../shared/schedules/queries'
import { useFormFacts } from '../formFacts'

// useScheduleChoice — расписания пространства формы и выбор одного из них. Один на две
// точки входа: раздел попапа блока (SlotSettings) и плашку «расписание не выбрано» на
// полотне (SlotControl). Пишут они одну живую колонку, и разойтись им нельзя.
//
// ⚠ ВЫБОР ХРАНИТСЯ НЕ В СХЕМЕ, А ЖИВОЙ КОЛОНКОЙ forms.schedule_id (ADR §10). Схема
// замерзает при публикации, и ссылка в ней потребовала бы перепубликации на смену
// расписания. Поэтому choose не зовёт updateBlock, как остальные настройки, а патчит
// саму форму и инвалидирует её деталь.
export function useScheduleChoice() {
  const facts = useFormFacts()
  const qc = useQueryClient()
  const schedules = useQuery({
    ...schedulesQueryOptions(facts?.workspaceId ?? ''),
    enabled: Boolean(facts?.workspaceId),
  })

  async function choose(scheduleId: string | null) {
    if (!facts) return
    // Формы может ещё не быть: расписание автор вправе выбрать первым действием, и
    // тогда черновик заводит оно само (FormFacts.id — обещание).
    const formId = typeof facts.id === 'string' ? facts.id : await facts.id()
    await setFormSchedule(formId, scheduleId)
    // Деталь формы несёт scheduleId — без инвалидации полотно и попап показывали бы
    // прежний выбор до перезагрузки страницы.
    await qc.invalidateQueries({ queryKey: formKeys.detailAll() })
  }

  return { facts, schedules, choose }
}
