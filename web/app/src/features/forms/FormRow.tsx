import { Link } from '@tanstack/react-router'
import { Link2, Pencil } from 'lucide-react'

import { type Form, displayFormName } from '../../entities/form'
import {
  conversionPercent,
  formatDate,
  formatRelativeDate,
  pluralAnswers,
} from '../../shared/format'
import { copyFormLink } from './copyLink'
import { FormActionsMenu } from './FormActionsMenu'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Раскладка строки и шапки колонок — ОДНА константа на два компонента: разъедься
// они хоть на четверть колонки, числа перестали бы стоять под своими подписями, и
// заметить это можно было бы только глазами.
//
// До `md` числовые колонки не рисуются вовсе, а не жмутся: пять правых колонок на
// 375 px оставляют названию сорок пикселей. Вместо них у названия появляется вторая
// строка со сводкой — те же числа словами.
const GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 md:grid-cols-[minmax(0,1fr)_4.5rem_4rem_4.5rem_7.5rem_6.75rem]'

// Шапка колонок. Отдельным рядом, а не первой строкой таблицы: `Table` здесь не
// взят намеренно — строка обязана быть ссылкой целиком, а `<tr>` ссылкой не
// становится (обернуть `<td>` в `<a>` нельзя, разметка недопустима).
export function FormRowsHeader() {
  return (
    <div
      className={cn(GRID, 'px-3 pb-1.5 text-xs text-muted-foreground')}
      // Подписи колонок дублируют то, что уже сказано в каждой строке словами
      // (48 ответов, конверсия 15 %), поэтому скринридеру они не нужны — а как
      // отдельная строка списка читались бы формой без названия.
      aria-hidden="true"
    >
      <span>Название</span>
      <span className="hidden text-right md:block">Просмотры</span>
      <span className="hidden text-right md:block">Ответы</span>
      <span className="hidden text-right md:block">Конверсия</span>
      <span className="hidden text-right md:block">Последний ответ</span>
      <span />
    </div>
  )
}

const statusLabels: Record<Form['status'], string> = {
  draft: 'Черновик',
  published: 'Опубликована',
  closed: 'Приём закрыт',
}

// Точка статуса. Цвет здесь — не единственный носитель смысла: рядом стоит
// sr-only-подпись, а у черновика и закрытой формы статус назван словом и в самой
// строке. Опубликованная ничем не помечена намеренно — это норма списка, и метка
// на каждой второй строке превращается в шум.
const statusDots: Record<Form['status'], string> = {
  draft: 'border border-muted-foreground/50',
  published: 'bg-success',
  closed: 'bg-muted-foreground',
}

// FormRow — строка списка форм. Нажимается ЦЕЛИКОМ: ссылка названия растянута
// псевдоэлементом на всю строку (`after:absolute after:inset-0`), поэтому ссылка в
// разметке остаётся одна — со своим адресом, средним кликом и контекстным меню
// браузера. Действия стоят выше по слою (`relative z-10`), иначе накрывающий слой
// съедал бы клики по ним.
export function FormRow({ form, workspaceSlug }: { form: Form; workspaceSlug: string }) {
  const label = displayFormName(form)
  const isPlaceholder = label === 'Без названия'
  const isDraft = form.status === 'draft'
  const percent = conversionPercent(form.visitSubmittedCount, form.visitCount)

  // Черновик открывается в редакторе, розданная форма (в т.ч. закрытая) — на
  // «Ответы»: она роздана, и ежедневный вопрос к ней «что написали?», а не «где
  // ссылка?». То же правило у строки поиска по пространствам — менять его в одном
  // месте из двух значит развести их. Редактор адресуется ЧЕРЕЗ ПРОСТРАНСТВО
  // (он обслуживает и черновик, который своё пространство назвать не может),
  // поэтому строка получает его пропом от списка.
  const target = isDraft
    ? ({
        to: '/w/$workspaceSlug/forms/$slug/edit',
        params: { workspaceSlug, slug: form.slug },
      } as const)
    : ({ to: '/forms/$slug/responses', params: { slug: form.slug } } as const)

  return (
    <div
      className={cn(
        GRID,
        'group relative rounded-md px-3 py-2.5 transition-colors',
        'hover:bg-accent/60 has-[a:focus-visible]:bg-accent/60',
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn('size-1.5 shrink-0 rounded-full', statusDots[form.status])}
            aria-hidden="true"
          />
          <Link
            {...target}
            className={cn(
              'min-w-0 truncate text-sm font-medium after:absolute after:inset-0 after:rounded-md',
              isPlaceholder && 'text-muted-foreground',
              isDraft && !isPlaceholder && 'text-muted-foreground',
            )}
          >
            {label}
            <span className="sr-only"> — {statusLabels[form.status]}</span>
          </Link>
          {/* Единственное состояние формы, которое может укусить: автор правил её
              после публикации, и респондент видит прежнюю. Метка жёлтая, потому что
              это предупреждение (DESIGN-SYSTEM §6), а не статус. */}
          {form.hasUnpublishedChanges && (
            <span className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-xs whitespace-nowrap">
              есть неопубликованные правки
            </span>
          )}
          {form.status === 'closed' && (
            <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs whitespace-nowrap text-muted-foreground">
              приём закрыт
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {isDraft && 'Черновик · '}
          Изменена {formatDate(form.updatedAt)}
          {/* Сводка вместо колонок на узком экране — те же числа, что справа на
              широком. Черновику её не показываем: считать у него нечего. */}
          {!isDraft && (
            <span className="md:hidden">
              {' · '}
              {form.submissionCount} {pluralAnswers(form.submissionCount)}
              {percent !== null && ` · ${percent} %`}
            </span>
          )}
        </p>
      </div>

      {/* Черновик не открывали ни разу — у него не «0», а «нечего считать»:
          нолями он читался бы как форма, которую все проигнорировали. */}
      <span className="hidden text-right text-sm text-muted-foreground tabular-nums md:block">
        {isDraft ? '—' : form.visitCount}
      </span>
      <span className="hidden text-right text-sm tabular-nums md:block">
        {isDraft ? <span className="text-muted-foreground">—</span> : form.submissionCount}
      </span>
      <span className="hidden text-right text-sm text-muted-foreground tabular-nums md:block">
        {isDraft || percent === null ? '—' : `${percent} %`}
      </span>
      <span className="hidden text-right text-xs text-muted-foreground md:block">
        {form.lastSubmissionAt ? formatRelativeDate(form.lastSubmissionAt) : '—'}
      </span>

      {/* Действия видны ВСЕГДА, а не по наведению: на тач-экране наведения не
          наступает никогда, и спрятанные под него действия недоступны совсем.
          Приглушены цветом — на строке их три, и в полную силу они спорили бы с
          названием за внимание. */}
      <div className="relative z-10 flex items-center justify-end text-muted-foreground">
        <Button asChild variant="ghost" size="icon-sm" aria-label={`Редактировать «${label}»`}>
          <Link to="/w/$workspaceSlug/forms/$slug/edit" params={{ workspaceSlug, slug: form.slug }}>
            <Pencil className="size-4" />
          </Link>
        </Button>
        {/* У черновика публичной страницы ещё нет — ссылка вела бы на 404. Кнопка
            остаётся на месте выключенной: исчезающая посреди списка кнопка сдвигала
            бы соседние на строках выше и ниже. */}
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={isDraft}
          aria-label={`Копировать ссылку на «${label}»`}
          onClick={() => copyFormLink(form.slug)}
        >
          <Link2 className="size-4" />
        </Button>
        <FormActionsMenu
          form={{ ...form, workspaceSlug }}
          align="end"
          // Уход на список после удаления стёр бы из адреса поиск и фильтр, в
          // которых человек работал: список — это и есть текущий экран.
          leaveAfterDelete={false}
        />
      </div>
    </div>
  )
}
