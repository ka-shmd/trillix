import { useNavigate } from '@tanstack/react-router'
import { Share2 } from 'lucide-react'

import { type Form } from '../../../entities/form'
import { usePublishForm } from '../queries'
import { Button } from '@/components/ui/button'

// PublishControls — кнопка публикации в тонкой шапке редактора. Логика жизненного
// цикла (ссылка, перепубликация, закрытие) переехала на страницу «Поделиться»:
//   • черновик (ещё не публиковали) → «Опубликовать» публикует и уводит на /share;
//   • уже публиковавшаяся (published/closed) → «Поделиться» просто ведёт на /share,
//     где живут ссылка, превью и управление.
//
// canPublish=false, пока есть несохранённые правки: публикация снимает снапшот
// серверного черновика, поэтому сначала он должен догнать редактор (автосейв).
export function PublishControls({ form, canPublish }: { form: Form; canPublish: boolean }) {
  const publish = usePublishForm()
  const navigate = useNavigate()

  const goShare = () => navigate({ to: '/forms/$formId/share', params: { formId: form.id } })
  const everPublished = form.publishedVersion !== null

  if (everPublished) {
    return (
      <Button variant="outline" size="sm" className="gap-1.5" onClick={goShare}>
        <Share2 className="size-4" /> Поделиться
      </Button>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        disabled={!canPublish || publish.isPending}
        title={!canPublish ? 'Дождитесь сохранения черновика' : undefined}
        onClick={() => publish.mutate(form.id, { onSuccess: goShare })}
      >
        {publish.isPending ? 'Публикуем…' : 'Опубликовать'}
      </Button>
      {publish.isError && (
        <p className="text-right text-xs text-destructive" role="alert">
          Не удалось опубликовать. Проверьте, что у вопросов есть заголовки, а у вариантов — текст.
        </p>
      )}
    </div>
  )
}
