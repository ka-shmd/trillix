import { Link } from '@tanstack/react-router'

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
export function SubmissionsTabs({ slug, children }: { slug: string; children?: React.ReactNode }) {
  const base = 'rounded-md px-2.5 py-1 text-sm transition-colors'
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
          search={(prev) => prev}
          className={base}
          activeProps={active}
          inactiveProps={inactive}
        >
          Все ответы
        </Link>
        <Link
          to="/forms/$slug/submissions/completed"
          params={{ slug }}
          search={(prev) => prev}
          className={base}
          activeProps={active}
          inactiveProps={inactive}
        >
          Законченные
        </Link>
        <Link
          to="/forms/$slug/submissions/partial"
          params={{ slug }}
          search={(prev) => prev}
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
