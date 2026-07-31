import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Share2, TriangleAlert } from 'lucide-react'

import { type Form } from '../../../entities/form'
import { usePublishForm } from '../queries'
import { type PublishBlocker } from './publishGate'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

// PublishControls — кнопка публикации в тонкой шапке редактора. Логика жизненного
// цикла (ссылка, перепубликация, закрытие) переехала на страницу «Поделиться»:
//   • черновик (ещё не публиковали) → «Опубликовать» публикует и уводит на /share;
//   • уже публиковавшаяся (published/closed) → «Поделиться» просто ведёт на /share,
//     где живут ссылка, превью и управление.
//
// Публиковать нельзя по ДВУМ разным причинам, и они не смешиваются (спека §6.3):
//   • canPublish=false — серверный черновик ещё не догнал редактор (автосейв);
//     публикация снимает снапшот именно серверного черновика.
//   • blockers — форма недособрана (гейт публикации, ADR §10, решение 5). Это не
//     «подождите», а «почините вот здесь», поэтому список с переходом к блоку.
export function PublishControls({
  form,
  canPublish,
  blockers,
  onJump,
}: {
  form: Form
  canPublish: boolean
  blockers: PublishBlocker[]
  // onJump — перевод каретки на строку блока. Приходит пропом, а не берётся из
  // контекста: кнопка живёт в портале шапки, и зависимость от того, попал ли портал
  // внутрь провайдера фокуса, была бы неявной и хрупкой.
  onJump: (blockId: string) => void
}) {
  const publish = usePublishForm()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const goShare = () => navigate({ to: '/forms/$slug/share', params: { slug: form.slug } })
  const everPublished = form.publishedVersion !== null

  if (everPublished) {
    return (
      <Button variant="outline" size="sm" className="gap-1.5" onClick={goShare}>
        <Share2 className="size-4" /> Поделиться
      </Button>
    )
  }

  const blocked = blockers.length > 0

  return (
    <div className="flex items-center gap-2">
      {blocked && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1.5 text-destructive">
              <TriangleAlert className="size-4" />
              Что мешает ({blockers.length})
            </Button>
          </PopoverTrigger>
          {/* Список в поповере, а не под кнопкой: шапка тонкая и sticky, а причин
              может быть сколько угодно — вставший в поток список сдвигал бы полотно. */}
          <PopoverContent align="end" className="w-80">
            <p className="mb-2 text-sm font-medium">Форму пока нельзя опубликовать</p>
            <ul className="space-y-1">
              {blockers.map((b) => (
                <li key={`${b.blockId}:${b.kind}`}>
                  {/* Кнопка, а не строка текста: причина — это адрес, и клик обязан
                      уводить к блоку. Каретка после перехода определена (§12 EDITOR). */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start whitespace-normal py-1 text-left text-xs font-normal"
                    onClick={() => {
                      setOpen(false)
                      onJump(b.blockId)
                    }}
                  >
                    {b.message}
                  </Button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
      <div className="flex flex-col items-end gap-1">
        <Button
          size="sm"
          disabled={!canPublish || blocked || publish.isPending}
          title={
            blocked
              ? 'Форма недособрана — посмотрите, что мешает'
              : !canPublish
                ? 'Дождитесь сохранения черновика'
                : undefined
          }
          onClick={() => publish.mutate(form.id, { onSuccess: goShare })}
        >
          {publish.isPending ? 'Публикуем…' : 'Опубликовать'}
        </Button>
        {publish.isError && (
          <p className="text-right text-xs text-destructive" role="alert">
            Не удалось опубликовать. Обновите страницу и попробуйте ещё раз.
          </p>
        )}
      </div>
    </div>
  )
}
