import { createContext, useContext } from 'react'

import { type FormIdSource } from './mediaUpload'

// Факты О ФОРМЕ, которых нет в схеме, но которые нужны полотну.
//
// Контекст, а не пропы: попап настроек блока живёт глубоко в строке (BlockRow →
// BlockActionMenu → Settings), и тащить туда три поля через каждый уровень значило бы
// расширить контракт всем типам ради одного.
//
// Всё здесь — ЖИВЫЕ КОЛОНКИ формы, а не документ: расписание записи меняется без
// перепубликации, и в схеме его нет намеренно (ADR §10).
export type FormFacts = {
  // id формы. Может быть обещанием: черновика ещё нет, пока автор не тронул полотно
  // (mediaUpload.FormIdSource) — а расписание он вправе выбрать первым действием.
  id: FormIdSource
  // workspaceId — пространство формы. Нужен списку расписаний: они принадлежат
  // пространству. Приезжает деталью формы, а не из адреса (TD-69).
  workspaceId: string
  // workspaceSlug — им адресуется пространство в URL кабинета: попап «Записи» ведёт
  // в расписания пространства ФОРМЫ, а не того, что подсказал адрес.
  workspaceSlug: string
  // scheduleId — выбранное расписание записи; null = не выбрано.
  scheduleId: string | null
}

const FormFactsContext = createContext<FormFacts | null>(null)

export const FormFactsProvider = FormFactsContext.Provider

// useFormFacts — факты формы; null вне полотна (превью, тесты отдельных строк).
export function useFormFacts(): FormFacts | null {
  return useContext(FormFactsContext)
}
