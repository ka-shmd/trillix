import { useNavigate } from '@tanstack/react-router'

import { useCreateFormFromTemplate } from './queries'
import { type FormTemplate, TEMPLATES, questionCaptions } from './templates'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

// Галерея встроенных шаблонов (/templates). Данные статичны (templates.ts), поэтому
// загрузки и пустоты у экрана нет — из состояний остаётся только ошибка создания
// формы, и она принадлежит нажатой карточке, а не странице.

// Сколько вопросов показывает карточка: список целиком превращает галерею в простыню,
// а первые несколько уже отвечают на вопрос «про что эта форма».
const PREVIEW_QUESTIONS = 4

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
  // Какую карточку нажали: мутация одна на всю галерею, а «Создаём…» и ошибка
  // принадлежат одной кнопке.
  const pendingId = create.isPending ? create.variables?.template.id : null

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

  // Ни колонки, ни заголовка здесь нет: их даёт страница. Пока галерея носила своё
  // и то и другое, «Шаблоны» печатались дважды — крошкой и заголовком, — а колонка
  // (max-w-5xl) не совпадала ни с одним соседним разделом пространства.
  return (
    <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {TEMPLATES.map((t) => {
        const captions = questionCaptions(t)
        const rest = captions.length - PREVIEW_QUESTIONS
        const failed = create.isError && create.variables?.template.id === t.id
        return (
          <li key={t.id}>
            <Card className="flex h-full flex-col gap-3 p-5">
              <div>
                <h2 className="font-medium">{t.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t.description}</p>
              </div>
              <ul className="flex-1 space-y-1 text-sm text-muted-foreground">
                {captions.slice(0, PREVIEW_QUESTIONS).map((q) => (
                  <li key={q} className="truncate">
                    · {q}
                  </li>
                ))}
                {rest > 0 && <li>· ещё {rest}</li>}
              </ul>
              <Button className="w-full" onClick={() => use(t)} disabled={create.isPending}>
                {pendingId === t.id ? 'Создаём…' : 'Использовать'}
              </Button>
              {failed && (
                <p role="alert" className="text-sm text-destructive">
                  Не удалось создать форму. Попробуйте ещё раз.
                </p>
              )}
            </Card>
          </li>
        )
      })}
    </ul>
  )
}
