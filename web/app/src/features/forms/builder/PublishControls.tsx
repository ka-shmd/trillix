import { Link, useNavigate } from '@tanstack/react-router'
import { Share2 } from 'lucide-react'

import { type FormDesign } from '@entities/formSchema'

import { type Form } from '../../../entities/form'
import { useFeatureAllowed } from '../../plan/useFeature'
import { planRequiredMessage } from '../../plan/planError'
import { usePublishForm } from '../queries'
import { hasCustomFields } from './designTheme'
import { useBuilderStore } from './storeContext'
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
// ПЛАТНОЕ В ФОРМЕ НАЗЫВАЕТСЯ ДО НАЖАТИЯ, а не только после отказа (решение владельца
// 2026-08-10). Шторка «Оформление» открыта всем и на любом тарифе: смотреть, менять и
// показывать в превью можно всё — за гейтом стоят отдельные её функции, и упирается в
// них автор ровно один раз, на публикации. Значит предупредить надо там же, где кнопка,
// и заранее: узнать о стене, уже нажав, — это узнать поздно.
//
// Список НЕ дублирует серверный (domain.DesignPaidFeatures): тот перечисляет настройки
// поимённо в теле 402, а здесь нужен ответ покрупнее — какие ВОЗМОЖНОСТИ задействованы.
// Дробить его на «цвета, шрифт, ширина» значило бы завести третью копию перечня, и
// первая же новая настройка развела бы их.
function paidInUse(
  design: FormDesign | undefined,
  allowCustom: boolean,
  allowCSS: boolean,
): string[] {
  const out: string[] = []
  if (!allowCustom && hasCustomFields(design)) out.push('своё оформление')
  if (!allowCSS && design?.css?.trim()) out.push('свой CSS')
  return out
}

export function PublishControls({ form, canPublish }: { form: Form; canPublish: boolean }) {
  const publish = usePublishForm()
  const navigate = useNavigate()
  const design = useBuilderStore((s) => s.design)
  const blocked = paidInUse(
    design,
    useFeatureAllowed('form_design_custom'),
    useFeatureAllowed('form_custom_css'),
  )
  const planMessage = planRequiredMessage(publish.error)

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
      {/* ПРЕДУПРЕЖДЕНИЕ ДО НАЖАТИЯ. Не красное и не блокирующее: это не ошибка
          автора, а состояние тарифа, и черновик со всем этим прекрасно живёт.
          Скрывается, как только сервер высказался, — два сообщения об одном и том
          же под одной кнопкой читаются как два разных повода. */}
      {blocked.length > 0 && !publish.isError && (
        <p className="text-muted-foreground text-right text-xs">
          В форме задействованы платные функции: {blocked.join(', ')}. Опубликовать её
          на текущем тарифе не получится —{' '}
          <Link to="/settings/plan" className="underline underline-offset-2">
            Тариф
          </Link>
        </p>
      )}
      {publish.isError && (
        <p className="text-right text-xs text-destructive" role="alert">
          {/* Отказ по тарифу — не сбой: повторять его бессмысленно, а вот ЧТО
              мешает, автор обязан прочитать. Сервер перечисляет мешающие
              настройки в сообщении (402 plan_required), и подменять его общей
              фразой значит заставить автора гадать. */}
          {planMessage !== null ? (
            <>
              {planMessage}{' '}
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
