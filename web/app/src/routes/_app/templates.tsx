import { createFileRoute } from '@tanstack/react-router'

// Шаблоны форм (/templates): встроенные заготовки, с которых начинают вместо пустого
// полотна. Маршрут заведён вместе со ссылкой «Использовать шаблон» на пустом полотне
// (SlashEditor, EmptyStarter) — галерею заготовок кладёт следующий шаг задачи.
export const Route = createFileRoute('/_app/templates')({
  component: TemplatesPage,
})

function TemplatesPage() {
  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Шаблоны</h1>
      <p className="text-sm text-muted-foreground">
        Готовые формы, которые можно взять за основу: берёте заготовку — получаете свою
        форму со всеми вопросами, дальше правите как обычно.
      </p>
    </div>
  )
}
