import { createFileRoute, redirect } from '@tanstack/react-router'

import { periodSchema } from '../../shared/period'
import { segmentsFromSearch, segmentsToSearch } from '../../shared/segment'

// Старый адрес «Отвалов». Экран переехал на «Обзор» — index раздела «Аналитика»
// (спека design/analytics-v3.md §2), а ссылка, отданная человеку однажды, ломаться
// не обязана: на воронку у владельца закладки, и на неё же ведёт уведомление о
// падении конверсии.
//
// Окно и разрез переносятся: закладка на воронку «Телефона» за 30 дней обязана
// открыть её же, а не всю форму за сутки. Период читается схемой — непонятное и
// неназванное окно она одинаково отдаёт умолчанием.
export const Route = createFileRoute('/_app/forms/$slug/_manage/insights/drop-offs')({
  beforeLoad: ({ params, search }) => {
    const s = search as Record<string, unknown>
    const segment = segmentsToSearch(segmentsFromSearch(s.segment))
    throw redirect({
      to: '/forms/$slug/insights',
      params,
      search: { period: periodSchema.parse(s.period), ...(segment ? { segment } : {}) },
    })
  },
})
