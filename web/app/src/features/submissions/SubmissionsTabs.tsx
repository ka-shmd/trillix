import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { submissionsCountQueryOptions } from './queries'
import { formDetailQueryOptions } from '../forms/queries'

// Ряд вкладок раздела «Ответы» и его правая половина. Вкладки — настоящие ссылки
// (навигация, а не переключатель), как разделы формы и вкладки аналитики: средний клик,
// «открыть в новой вкладке» и «Назад» обязаны работать. Взаимоисключающие наборы классов
// разведены по activeProps/inactiveProps — смешивать их нельзя (у Tailwind-утилит
// одинаковая специфичность, побеждает порядок в сгенерированном CSS, а не в строке
// className).
//
// Сегментированный переключатель, тот же, что у вкладок аналитики: разделы формы над ним
// — подчёркнутые вкладки, и второй ряд того же вида читался бы как продолжение первого.
//
// РЯД РИСУЕТ КАЖДАЯ ВКЛАДКА, а не оболочка раздела, хотя вкладки в нём одни и те же.
// Причина в правой половине (`children`): выгрузка относится к данным ОТКРЫТОЙ вкладки, и
// оболочка, чтобы её показать, тянула бы список ответов даже там, где он не нужен, — а на
// «Частичных» предлагала бы скачать чужой файл.
//
// Своего нижнего отступа у ряда НЕТ: расстояние до содержимого задаёт страница. Ряд стоит
// вплотную к таблице (решение владельца) — он её орган управления, а не отдельный этаж.
//
// ЧИСЛО У ВКЛАДКИ БЕРЁТСЯ СВОИМ ЗАПРОСОМ (`/submissions/count`), а не из списка открытой
// вкладки: иначе на «Частичных», где списка нет, числа пропали бы у всех трёх сразу.
// Запрос дешёвый и общий с карточкой «Ответы» на «Аналитике» — кеш TanStack отдаёт его
// одним походом на оба экрана.
//
// У «ЧАСТИЧНЫХ» ЧИСЛА НЕТ ВОВСЕ. Их счётчик — не тот же запрос: он лежит за гейтом
// тарифа и тумблером формы, и спрашивать его на всех трёх вкладках значило бы ходить
// за ним там, где он не нужен. А «0» у формы, которая незавершённые не собирает, был
// бы не пустотой, а враньём.
export function SubmissionsTabs({ slug, children }: { slug: string; children?: React.ReactNode }) {
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const count = useQuery({
    // Окно наблюдения «всё время»: раздел «Ответы» периода не имеет — в отличие от
    // «Аналитики», где то же число режется выбранным окном.
    ...submissionsCountQueryOptions(formId ?? '', 'all'),
    enabled: formId !== undefined,
  })
  const submitted = count.data?.submissions

  const base = 'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors'
  const active = { className: 'bg-background font-semibold text-foreground shadow-sm' }
  const inactive = { className: 'font-medium text-muted-foreground hover:text-foreground' }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav
        className="inline-flex h-9 items-center gap-0.5 rounded-lg bg-muted p-[3px]"
        aria-label="Разделы ответов"
      >
        <Link
          to="/forms/$slug/submissions/all"
          params={{ slug }}
          className={base}
          activeProps={active}
          inactiveProps={inactive}
        >
          Все ответы
          <TabCount value={submitted} />
        </Link>
        <Link
          to="/forms/$slug/submissions/completed"
          params={{ slug }}
          className={base}
          activeProps={active}
          inactiveProps={inactive}
        >
          Законченные
          <TabCount value={submitted} />
        </Link>
        <Link
          to="/forms/$slug/submissions/partial"
          params={{ slug }}
          className={base}
          activeProps={active}
          inactiveProps={inactive}
        >
          Частичные
        </Link>
      </nav>
      {children && <div className="flex items-center gap-3">{children}</div>}
    </div>
  )
}

// Число у вкладки — приглушённое и моноширинными цифрами: подпись называет вкладку, а
// число уточняет, и одинаковыми чернилами они читались бы как одна надпись. Табличные
// цифры держат ширину ряда постоянной, пока счётчик тикает.
function TabCount({ value }: { value?: number }) {
  if (value === undefined) return null
  return <span className="text-xs font-normal text-muted-foreground tabular-nums">{value}</span>
}
