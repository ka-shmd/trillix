import { useCallback, useMemo, type KeyboardEvent } from 'react'

import { type Span, isAnswerableType } from '@entities/formSchema'
import { MENTION_ALL_ANSWERS, type FormDetail } from '../../../entities/form'
import { type MentionItem } from '../builder/MentionMenu'
import { RichLine } from '../builder/RichLine'
import { sourceLabel } from '../builder/logic/model'

// Строка бланка письма: тот же RichLine, что стоит в строках полотна, — меню «@»,
// неделимый чип, переносы строк (docs/design/mentions.md §10). Своей реализации чипа
// внутри contenteditable здесь нет и не будет: это ровно та граница «браузер ↔ наш
// код», на которой жили все шесть дефектов фазы 14, и второй такой границы не заводим.
//
// Отличий от полотна три, и все три — про природу поверхности, а не про вид:
// подстановка берёт ЛЮБОЙ вопрос формы (правила «источник выше носителя» здесь нет —
// письмо пишется по готовому ответу), плоский Enter переносит строку (строк документа
// в письме нет), а панели форматирования не поднимается вовсе — письмо plain text.
export function MailLine({
  form,
  value,
  onChange,
  label,
  placeholder,
  className,
  multiline = false,
  editable,
}: {
  form: FormDetail
  value: Span[]
  onChange: (value: Span[]) => void
  label: string
  placeholder?: string
  className?: string
  // multiline — текст письма (перенос строки по Enter, источник «Все ответы» в меню);
  // false — тема, у которой ни того, ни другого: она уезжает в ОДНУ строку заголовка.
  multiline?: boolean
  editable: boolean
}) {
  const items = useMailMentionItems(form, multiline)
  const sources = useCallback(() => items, [items])
  const live = useMemo(() => new Set(items.map((i) => i.id)), [items])

  return (
    <RichLine
      value={value}
      placeholder={placeholder ?? ''}
      label={label}
      className={className}
      readOnly={!editable}
      enterBreaksLine={multiline}
      mentionSources={editable ? sources : undefined}
      mentionLive={live}
      onChange={(next) => onChange(next)}
      // Enter в ТЕМЕ не делает ничего: перенос в ней невозможен (тема — одна строка), а
      // браузер, получив клавишу, вставил бы <br> мимо модели.
      onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
        if (e.key === 'Enter') e.preventDefault()
      }}
      onFocus={noop}
      onBlur={noop}
      elRef={noop}
    />
  )
}

// Что предлагает меню «@» в бланке. Список считается по ЧЕРНОВИКУ формы: автор правит
// письмо рядом с формой, которую сейчас редактирует, и ждёт в меню её вопросы. Ответ
// придёт по ОПУБЛИКОВАННОЙ версии — чип на ещё не опубликованный вопрос до публикации
// инертен, как и всякая неразрешимая ссылка (mentions.md §4).
function useMailMentionItems(form: FormDetail, withAll: boolean): readonly MentionItem[] {
  const blocks = form.draftSchema.blocks
  return useMemo(() => {
    const items: MentionItem[] = []
    // «Все ответы» стоит ПЕРВЫМ: это самая частая подстановка в письме — она и есть то,
    // что автор теряет, заменяя дефолтный текст своим.
    if (withAll) items.push({ id: MENTION_ALL_ANSWERS, label: 'Все ответы' })
    for (const b of blocks) {
      // Вопрос-файл отдельным источником не предлагается (design/answer-files.md §9):
      // имя файла — не тот ответ, который имеет смысл подставлять в фразу. Внутри «Все
      // ответы» он при этом печатается именами: там перечисляется ВЕСЬ ответ.
      if (!isAnswerableType(b.type) || b.type === 'file') continue
      items.push({ id: b.id, label: sourceLabel(blocks, b) })
    }
    return items
  }, [blocks, withAll])
}

const noop = () => {}
