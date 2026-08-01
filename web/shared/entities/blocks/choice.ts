import { type SchemaIssue } from './contract'
import { type Settings } from './settings'

// Общее правило трёх choice-типов: id вариантов уникальны в пределах блока. Ответ
// ссылается на id, поэтому дубль означал бы, что один ответ попадает в два варианта
// сводки.
//
// Живёт отдельным файлом, а не тремя копиями в single_choice/dropdown/multi_choice:
// правило одно, и разъехавшиеся копии дали бы формы, которые одна поверхность считает
// валидными, а другая нет. Ровно так до фазы 16 жило правило «что считать вопросом»,
// пока его не свели в domain.QuestionOrder.
//
// Пустой список законен — это недособранный черновик, который автосейв обязан хранить.
// Требование «≥1 вариант» — правило момента публикации, не хранения.
export const choiceIssues = (s: Settings): SchemaIssue[] => {
  const options = s.options
  if (!options) return []
  const seen = new Set<string>()
  const out: SchemaIssue[] = []
  options.forEach((o, i) => {
    if (seen.has(o.id)) {
      out.push({ message: `повторяющийся id опции ${o.id}`, path: ['settings', 'options', i, 'id'] })
    }
    seen.add(o.id)
  })
  return out
}
