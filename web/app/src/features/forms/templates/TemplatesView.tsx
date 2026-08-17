import { useNavigate } from '@tanstack/react-router'

import { useCurrentWorkspaceId } from '../../../shared/currentWorkspace'
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

export function TemplatesView() {
  const navigate = useNavigate()
  // Форма из шаблона ложится в то пространство, в котором человек сейчас работает, —
  // как и «Новая форма» в сайдбаре (пусто = личное).
  const workspaceId = useCurrentWorkspaceId()
  const create = useCreateFormFromTemplate()
  // Какую карточку нажали: мутация одна на всю галерею, а «Создаём…» и ошибка
  // принадлежат одной кнопке.
  const pendingId = create.isPending ? create.variables?.template.id : null

  function use(template: FormTemplate) {
    create.mutate(
      { template, workspaceId: workspaceId || undefined },
      {
        onSuccess: (form) =>
          navigate({
            to: '/forms/$slug/edit',
            params: { slug: form.slug },
            search: (prev) => prev,
          }),
      },
    )
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Шаблоны</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Готовая форма вместо пустого полотна: берёте заготовку — получаете свою форму со
        всеми вопросами, дальше правите как обычно.
      </p>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                <Button
                  className="w-full"
                  onClick={() => use(t)}
                  disabled={create.isPending}
                >
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
    </div>
  )
}
