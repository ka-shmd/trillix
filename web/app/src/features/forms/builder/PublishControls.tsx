import { Link, useNavigate } from '@tanstack/react-router'
import { Share2 } from 'lucide-react'

import { type Form } from '../../../entities/form'
import { ApiError } from '../../../shared/api/errors'
import { usePublishForm } from '../queries'
import { Button } from '@/components/ui/button'

// PublishControls — кнопка публикации в тонкой шапке редактора. Логика жизненного
// цикла (ссылка, перепубликация, закрытие) переехала на страницу «Поделиться»:
//   • черновик (ещё не публиковали) → «Опубликовать» публикует и уводит на /share;
//   • уже публиковавшаяся (published/closed) → «Поделиться» просто ведёт на /share,
//     где живут ссылка, превью и управление.
//
// ГЕЙТ ТАРИФА КНОПКУ НЕ ГАСИТ (фаза 22): своё оформление можно настраивать и
// сохранять на любом тарифе, а отказывает публикация — 402 со списком мешающего,
// который показывается тут же. Погашенная заранее кнопка означала бы, что автор
// узнаёт о стене, не увидев, что за ней.
//
// canPublish=false, пока есть несохранённые правки: публикация снимает снапшот
// серверного черновика, поэтому сначала он должен догнать редактор (автосейв). Это
// ЕДИНСТВЕННАЯ причина, по которой кнопка бывает неактивна: гейта публикации в
// проекте нет (ADR §10, решение владельца 2026-07-31) — недособранная форма
// публикуется, а безымянный вопрос получает сгенерированное имя.
// planRequiredText — сообщение сервера без служебного префикса сентинела
// («plan required: …»): человеку показываем то, что после двоеточия.
function planRequiredText(message: string): string {
  const i = message.indexOf(': ')
  return i >= 0 ? message.slice(i + 2) : message
}

export function PublishControls({ form, canPublish }: { form: Form; canPublish: boolean }) {
  const publish = usePublishForm()
  const navigate = useNavigate()

  const goShare = () =>
    navigate({ to: '/forms/$slug/share', params: { slug: form.slug }, search: (prev) => prev })
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
          {/* Отказ по тарифу — не сбой: повторять его бессмысленно, а вот ЧТО
              мешает, автор обязан прочитать. Сервер перечисляет мешающие
              настройки в сообщении (402 plan_required), и подменять его общей
              фразой значит заставить автора гадать. Ветвимся по code, а не по
              тексту (web/CLAUDE.md). */}
          {publish.error instanceof ApiError && publish.error.code === 'plan_required' ? (
            <>
              {planRequiredText(publish.error.message)}{' '}
              <Link to="/settings/plan" className="underline underline-offset-2">
                Тариф
              </Link>
            </>
          ) : (
            'Не удалось опубликовать. Обновите страницу и попробуйте ещё раз.'
          )}
        </p>
      )}
    </div>
  )
}
