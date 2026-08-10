import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Share2 } from 'lucide-react'

import { type FormDesign } from '@entities/formSchema'

import { type Form } from '../../../entities/form'
import { useFeatureAllowed } from '../../plan/useFeature'
import { planRequiredMessage } from '../../plan/planError'
import { usePublishForm } from '../queries'
import { hasCustomFields } from './designTheme'
import { useBuilderStore } from './storeContext'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
// ПЛАТНОЕ В ФОРМЕ ОБЪЯСНЯЕТСЯ ДИАЛОГОМ ПО НАЖАТИЮ (решение владельца 2026-08-10).
// Шторка «Оформление» открыта всем и на любом тарифе: смотреть, менять и показывать в
// превью можно всё — за гейтом стоят отдельные её функции, и упирается в них автор
// ровно один раз, на публикации.
//
// Кнопка при этом ОБЫЧНАЯ — ни `disabled`, ни вида погашенной. Две редакции до этой
// были сняты владельцем и обе по делу: строка под кнопкой разъезжала шапку (кнопка
// живёт в баре, портированном в общую полосу), а тост уезжал сам и уносил с собой
// единственную подсказку, куда идти за подпиской. От автора здесь требуется решение —
// снять платное или оплатить, — а решение спрашивают диалогом.
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
  // Диалог «нужна подписка» — локальный UI-стейт: перезагрузку не переживает и никому
  // за пределами этой кнопки не нужен (web/CLAUDE.md).
  const [refused, setRefused] = useState(false)

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
        onClick={() => {
          if (blocked.length > 0) {
            setRefused(true)
            return
          }
          publish.mutate(form.id, { onSuccess: goShare })
        }}
      >
        {publish.isPending ? 'Публикуем…' : 'Опубликовать'}
      </Button>

      {/* Диалог, а не строка под кнопкой и не тост: строка разъезжала шапку (кнопка
          живёт в общем баре), а тост уезжает сам и уносит с собой единственную
          подсказку, куда идти за подпиской. Здесь же от автора требуется решение —
          снять платное или оплатить, — а решение спрашивают диалогом. */}
      <AlertDialog open={refused} onOpenChange={setRefused}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>В форме есть элементы платной подписки</AlertDialogTitle>
            <AlertDialogDescription>
              Чтобы опубликовать эту форму, нужна подписка. Задействовано:{' '}
              {blocked.join(', ')}. Черновик сохраняется и правится на любом тарифе —
              платной остаётся только публикация.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Закрыть</AlertDialogCancel>
            <AlertDialogAction onClick={() => navigate({ to: '/settings/plan' })}>
              Оформить подписку
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
