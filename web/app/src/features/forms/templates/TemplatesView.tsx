import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { Card } from '@/components/ui/card'

import { useCreateFormFromTemplate } from './queries'
import { TemplateDialog } from './TemplateDialog'
import { TemplateThumb } from './TemplateSheet'
import { type FormTemplate, TEMPLATES } from './templates'

// Галерея встроенных шаблонов. Данные статичны (templates.ts), поэтому загрузки и
// пустоты у экрана нет — из состояний остаётся только ошибка создания формы, и она
// принадлежит окну шаблона, из которого нажимали.
//
// ПЛИТКА — ЭТО ПРЕВЬЮ ФОРМЫ (решение владельца 2026-09-08). До этого карточка
// перечисляла первые четыре вопроса строчками «· Как вас зовут?» — то есть отвечала
// на «про что шаблон» текстом там, где ответ есть картинкой; дизайн-система прямо
// называет такую карточку строкой в три этажа (DESIGN-SYSTEM §7). Теперь плитка
// показывает форму, а не рассказывает о ней.
//
// workspaceId — куда положить форму из шаблона: то пространство, в котором человек
// сейчас работает (undefined = личное либо «ещё не знаем», см. маршрут). Приезжает
// пропом, а не читается отсюда: текущее пространство резолвит фича пространств, а
// импорт фичи из фичи запрещён (web/CLAUDE.md) — связывает их маршрут.
export function TemplatesView({
  workspaceId,
  workspaceSlug,
}: {
  workspaceId?: string
  workspaceSlug: string
}) {
  const navigate = useNavigate()
  const create = useCreateFormFromTemplate()
  const [opened, setOpened] = useState<FormTemplate | null>(null)

  function use(template: FormTemplate) {
    create.mutate(
      { template, workspaceId },
      {
        onSuccess: (form) =>
          navigate({
            to: '/w/$workspaceSlug/forms/$slug/edit',
            params: { workspaceSlug, slug: form.slug },
          }),
      },
    )
  }

  // Ни колонки, ни заголовка здесь нет: их даёт страница.
  return (
    <>
      {/* ЧИСЛО КОЛОНОК ЗАДАНО, А НЕ ВЫЧИСЛЕНО ИЗ ШИРИНЫ ПЛИТКИ (решение владельца
          2026-09-08: плитки широкие, в ряду их мало). Потолок — три; на широком
          мониторе плитка растёт, а не появляется четвёртая, и вместе с плиткой растёт
          масштаб миниатюры: у экрана 16:9 читаемость вопросов держится именно
          шириной. `auto-fill` здесь не годится — он делает ровно обратное, добавляя
          столбцы и оставляя плитку у нижней границы. Отбивка 32 — ритм сетки
          каталога. */}
      <ul className="mt-8 grid gap-8 md:grid-cols-2 2xl:grid-cols-3">
        {TEMPLATES.map((t) => (
          <li key={t.id} className="relative">
            <Card className="gap-0 overflow-hidden p-0 transition-shadow hover:shadow-md">
              <TemplateThumb template={t} />
              <div className="border-t p-4">
                <h2 className="truncate text-base font-semibold">{t.title}</h2>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{t.description}</p>
              </div>
            </Card>
            {/* НАЖИМАЕТСЯ ВСЯ ПЛИТКА, и делает это отдельная кнопка поверх неё, а не
                обёртка вокруг: внутри стоит лист формы с настоящими полями, а
                контролы в <button> вкладывать нельзя. Приём тот же, что у строки
                формы (FormRow) — растянутая на карточку невидимая кнопка с именем
                словами; миниатюра под ней inert, поэтому перехватить нажатие ей
                нечем. */}
            <button
              type="button"
              className="absolute inset-0 rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              onClick={() => setOpened(t)}
            >
              <span className="sr-only">Посмотреть шаблон «{t.title}»</span>
            </button>
          </li>
        ))}
      </ul>

      <TemplateDialog
        template={opened}
        onOpenChange={(open) => !open && setOpened(null)}
        onUse={use}
        pending={create.isPending}
        failed={create.isError && create.variables?.template.id === opened?.id}
      />
    </>
  )
}
