import { conversionPercent, pluralAnswers, pluralViews } from '../../shared/format'

// «N просмотров → M ответов (K %)» — числитель со знаменателем (фаза 8.5 шаг 6).
// Без знаменателя «12 ответов» не значит ничего: 12 из 15 открывших и 12 из 900 —
// противоположные новости, а показаны были бы одинаково.
//
// Осознанная асимметрия чисел: «M ответов» — это submissionCount, ровно то же
// число, что в таблице ответов (расхождение между двумя экранами кабинета
// читалось бы как баг). Процент же считается ПО ВИЗИТАМ (submitted/total), а не
// делением M на N: ответ мог прийти без визита, и частное двух независимых
// счётчиков конверсией не является (ADR §10). На практике они совпадают.
export function FormStats({
  visits,
  submittedVisits,
  submissions,
}: {
  visits: number
  submittedVisits: number
  submissions: number
}) {
  // Форму опубликовали, но её ещё никто не открывал — писать «0 % конверсии»
  // преждевременно и обидно. Показываем сам факт: смотреть пока нечего.
  if (visits === 0) {
    return <span>Пока нет просмотров</span>
  }

  const percent = conversionPercent(submittedVisits, visits)
  return (
    <span>
      {visits} {pluralViews(visits)} → {submissions} {pluralAnswers(submissions)}
      {percent !== null && ` (${percent} %)`}
    </span>
  )
}
