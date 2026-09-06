import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Link2, X } from 'lucide-react'
import { toast } from 'sonner'

import { type FormDesign } from '@entities/formSchema'

import { type Form } from '../../../entities/form'
import { useFeatureAllowed } from '../../plan/useFeature'
import { planRequiredMessage } from '../../plan/planError'
import { usePublishForm } from '../queries'
import { type FormRef } from './useAutosave'
import { dropPaid, hasCustomFields } from './designTheme'
import { useBuilderStore } from './storeContext'
import { useFormFacts } from './formFacts'
import { publishBlockers } from './publishGate'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// PublishControls — кнопка публикации в тонкой шапке редактора. «Опубликовать»
// стоит здесь ВСЕГДА, в любом состоянии формы: публикация — действие редактора, и
// у уже опубликованной формы она уносит на живую форму накопленные правки.
//   • черновик (ещё не публиковали) → публикует и уводит на /share, где ссылка;
//   • уже публиковавшаяся (published/closed) → публикует и ОСТАВЛЯЕТ в редакторе
//     (автор правит форму, а не ищет ссылку), а рядом появляется иконка на /share;
//   • закрытая форма той же кнопкой открывается снова (publish снимает closed).
//
// hasUnpublishedChanges приходит с сервера на GET, а после каждого автосейва его
// проставляет сам автосейв (useAutosave) — иначе подпись «есть изменения» появлялась
// бы только после перезагрузки страницы.
//
// ГЕЙТ ТАРИФА КНОПКУ НЕ ГАСИТ (фаза 22): своё оформление можно настраивать и
// сохранять на любом тарифе, а отказывает публикация — 402 со списком мешающего,
// который показывается тут же. Погашенная заранее кнопка означала бы, что автор
// узнаёт о стене, не увидев, что за ней.
//
// КНОПКА БЫВАЕТ НЕАКТИВНА ПО ДВУМ ПРИЧИНАМ, и обе называются тултипом на ней самой
// (решение владельца 2026-09-04 — подпись рядом с контролом отвергнута):
//
//  1. есть несохранённые правки: публикация снимает снапшот СЕРВЕРНОГО черновика,
//     поэтому сначала он должен догнать редактор (автосейв);
//  2. форма записи недособрана — не выбрано расписание либо нет обязательного
//     вопроса о почте (publishGate.ts, зеркало гейта в forms.Publish).
//
// Общего гейта публикации в проекте по-прежнему нет (ADR §10, решение владельца
// 2026-07-31): недособранная форма публикуется, безымянный вопрос получает
// сгенерированное имя. Запись — исключение, и узкое: без расписания она ничего не
// предложит, а без почты записавшийся не получит ссылку отмены и не сможет
// отказаться — место будет стоять занятым до самого приёма.
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

// PublishButton — обёртка кнопки тултипом с причиной запрета.
//
// ⚠ ОБЁРТКА-SPAN ОБЯЗАТЕЛЬНА: у запрещённой кнопки нет pointer-событий, и тултип на
// ней самой не открылся бы — то есть причина оказалась бы недоступна ровно тогда,
// когда она нужна. Тот же приём, что у запрещённого тумблера «страница благодарности»
// (kinds/pageBreakField.tsx).
function PublishButton({ reasons, children }: { reasons: string[]; children: ReactNode }) {
  if (reasons.length === 0) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <ul className="flex flex-col gap-1 text-left">
          {reasons.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

// ensureForm — адрес формы на сервере, добытый по надобности: у нового черновика
// формы ещё нет (ленивое создание), а публикация пустой формы законна как и раньше
// (гейта публикации в проекте нет, ADR §10) — значит, нажатие обязано её завести.
export function PublishControls({
  form,
  canPublish,
  ensureForm,
}: {
  form: Form
  canPublish: boolean
  ensureForm: () => Promise<FormRef>
}) {
  const publish = usePublishForm()
  const navigate = useNavigate()
  const design = useBuilderStore((s) => s.design)
  const blocks = useBuilderStore((s) => s.blocks)
  const setDesign = useBuilderStore((s) => s.setDesign)
  const allowCustom = useFeatureAllowed('form_design_custom')
  const allowCSS = useFeatureAllowed('form_custom_css')
  const blocked = paidInUse(design, allowCustom, allowCSS)
  // Расписание — ЖИВАЯ КОЛОНКА формы, и в карточке `Form` его нет: оно приезжает
  // фактами полотна (formFacts), теми же, которыми пользуется попап блока.
  const facts = useFormFacts()
  const gate = publishBlockers(blocks, facts?.scheduleId ?? null)
  // Причин может быть две (нет расписания И нет почты) — тогда в тултипе две строки,
  // а не одна фраза через точку: автор читает список того, что доделать.
  // Несохранённое стоит первым и вытесняет остальное: оно проходит само за секунду.
  const reasons = !canPublish ? ['Дождитесь сохранения черновика'] : gate.map((b) => b.text)
  const planMessage = planRequiredMessage(publish.error)
  // Диалог «нужна подписка» — локальный UI-стейт: перезагрузку не переживает и никому
  // за пределами этой кнопки не нужен (web/CLAUDE.md).
  const [refused, setRefused] = useState(false)

  // Slug берётся у формы, а не у пропа: только что созданная форма получила его
  // секунду назад, и проп мог ещё не доехать до этого замыкания.
  const goShare = (slug: string) => navigate({ to: '/forms/$slug/share', params: { slug } })
  const everPublished = form.publishedVersion !== null

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {/* Подсказка стоит В СТРОКЕ шапки, а не под ней: строка под кнопкой
            разъезжает бар по высоте (кнопка портирована в общую полосу). */}
        {everPublished && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={() => void goShare(form.slug)}
            aria-label="Ссылка на форму"
            title="Ссылка на форму"
          >
            <Link2 className="size-4" />
          </Button>
        )}
        {everPublished && form.hasUnpublishedChanges && (
          <Badge variant="outline" className="border-transparent bg-accent text-accent-foreground">
            Есть изменения
          </Badge>
        )}
        <PublishButton reasons={reasons}>
          <Button
            size="sm"
            disabled={reasons.length > 0 || publish.isPending}
            onClick={() => {
              if (blocked.length > 0) {
                setRefused(true)
                return
              }
              // Уводим на /share только с первой публикации: там автор впервые берёт
              // ссылку. Перепубликация — правка живой формы, и уносить из редактора её
              // автора незачем.
              void ensureForm()
                .then(({ id, slug }) =>
                  publish.mutate(
                    id,
                    everPublished ? undefined : { onSuccess: () => void goShare(slug) },
                  ),
                )
                // Провалиться здесь может только создание формы (публикация свои ошибки
                // показывает сама, ниже): нажали «Опубликовать» на нетронутом черновике,
                // и завести его не вышло. Молчащая кнопка в этом месте — худший исход.
                .catch(() => toast.error('Не удалось создать форму. Попробуйте ещё раз.'))
            }}
          >
            {publish.isPending ? 'Публикуем…' : 'Опубликовать'}
          </Button>
        </PublishButton>
      </div>

      {/* Диалог, а не строка под кнопкой и не тост: строка разъезжала шапку (кнопка
          живёт в общем баре), а тост уезжает сам и уносит с собой единственную
          подсказку, куда идти за подпиской. Здесь же от автора требуется решение —
          снять платное или оплатить, — а решение спрашивают диалогом. */}
      <AlertDialog open={refused} onOpenChange={setRefused}>
        <AlertDialogContent>
          {/* КРЕСТИК ВМЕСТО КНОПКИ «ЗАКРЫТЬ» (решение владельца 2026-08-28): в подвале
              теперь два настоящих выхода — снять платное или оплатить, — и третья
              кнопка рядом с ними читалась бы таким же выходом, хотя она про «я пока
              ничего не решил». Отказ от решения живёт в углу, как у всех окон.
              Cancel, а не свой обработчик: на нём же висят Escape и возврат фокуса. */}
          <AlertDialogCancel asChild variant="ghost" size="icon-sm">
            <button
              type="button"
              aria-label="Закрыть"
              className="text-muted-foreground absolute top-4 right-4"
            >
              <X className="size-4" />
            </button>
          </AlertDialogCancel>
          <AlertDialogHeader>
            <AlertDialogTitle>В форме есть элементы платной подписки</AlertDialogTitle>
            <AlertDialogDescription>
              Чтобы опубликовать эту форму, нужна подписка. Задействовано: {blocked.join(', ')}.
              Черновик сохраняется и правится на любом тарифе — платной остаётся только публикация.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* ВТОРОЙ ВЫХОД — СНЯТЬ ПЛАТНОЕ И ОПУБЛИКОВАТЬ КАК ЕСТЬ. Диалог до этого
                называл стену, но выводил из неё одной дорогой: автор, которому нужна
                форма сейчас, а не подписка, оставался с ней один на один и вычищал
                настройки руками, гадая, какие именно мешают.

                Снимается РОВНО ЗАКРЫТОЕ (dropPaid), а не всё своё: право на цвета и
                право на CSS раздельные. Правка идёт через стор, поэтому это обычный
                шаг истории — Ctrl+Z возвращает, и тост об этом говорит: действие
                стирает работу, а сообщение о возврате должно стоять там же, где потеря.

                Кнопка не публикует сама. Публикация — снапшот СЕРВЕРНОГО черновика, а
                снятое ещё не доехало автосейвом; нажатая тут же, она отправила бы на
                сервер прежний документ и получила тот же 402. */}
            <Button
              variant="outline"
              onClick={() => {
                setDesign(dropPaid(design, allowCustom, allowCSS))
                setRefused(false)
                toast.success('Платное оформление снято. Вернуть — Ctrl+Z')
              }}
            >
              Убрать платное оформление
            </Button>
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
