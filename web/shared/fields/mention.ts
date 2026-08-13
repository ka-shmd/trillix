import { createContext, useContext } from 'react'

import {
  CONSENT_YES,
  type Block,
  isAnswerableType,
  isMultiChoiceType,
  isSingleChoiceType,
} from '@entities/formSchema'

import { type Answer } from './answer'
import { type Answers, type FormPlan } from './logic'

// Подстановка ответа в тексте формы (docs/design/mentions.md). Кусок текста с полем
// `ref` — ссылка на ответ вопроса, стоящего ВЫШЕ: у респондента на его месте стоит
// собственный ответ, обновляющийся по мере ввода.
//
// Здесь живут две вещи: чем именно подставляется ответ (answerText) и когда ссылка
// разрешима (mentionResolver). Обе — общие для рендерера и превью билдера: разъедься
// они, и автор увидел бы в превью не то, что респондент, а проверить подстановку
// иначе как превью нельзя.

// answerText — ответ в виде текста, который встанет в строку.
//
// Это НЕ formatAnswer кабинета (features/submissions): тот показывает ответ в таблице,
// и там у согласия осмысленно печатать «Нет». Здесь незаполненное согласие обязано
// давать ПУСТО — пустая подстановка и есть отсутствие ответа (§4 спеки), а «Нет»
// посреди подписи вопроса было бы утверждением, которого респондент не делал.
export function answerText(block: Block, value: Answer | undefined): string {
  if (value === undefined) return ''
  // Выбор отдаёт ПОДПИСЬ варианта, а не его id: id — внутренняя кодировка, и в тексте
  // формы она бессмысленна. Предикатами, а не по типу: новый choice-тип иначе молча
  // подставлял бы сырой id.
  if (isSingleChoiceType(block.type)) return optionLabel(block, asString(value))
  if (isMultiChoiceType(block.type)) {
    const ids = Array.isArray(value) ? value : [value]
    return ids.map((id) => optionLabel(block, id)).join(', ')
  }
  if (block.type === 'consent') return value === CONSENT_YES ? 'Да' : ''
  return Array.isArray(value) ? value.join(', ') : value
}

function optionLabel(block: Block, id: string): string {
  const opt = block.settings?.options?.find((o) => o.id === id)
  return opt?.label ? opt.label : id
}

function asString(value: Answer): string {
  return Array.isArray(value) ? (value[0] ?? '') : value
}

// Резолвер: (id источника, id блока-носителя) → текст подстановки. Пустая строка
// значит «подставлять нечего», и все четыре инертных случая (§4 спеки) дают именно её:
// источника нет, источник не отвечаемый, источник стоит НЕ ВЫШЕ носителя, источник
// скрыт логикой. Отказа тут нет ни в одном случае — схема с неразрешимой ссылкой
// валидна, и её показывают, а не ломают.
export type MentionResolver = (ref: string, carrierId: string) => string

export function mentionResolver(
  blocks: readonly Block[],
  answers: Answers,
  plan?: FormPlan,
): MentionResolver {
  const pos = new Map<string, number>()
  const byId = new Map<string, Block>()
  blocks.forEach((b, i) => {
    pos.set(b.id, i)
    byId.set(b.id, b)
  })
  return (ref, carrierId) => {
    const src = byId.get(ref)
    if (!src || !isAnswerableType(src.type)) return ''
    // Носитель, которого нет в списке, ограничением не является: позиция неизвестна,
    // и придумывать её строже, чем «где-то в конце», значило бы гасить подстановку на
    // поверхности, про которую резолвер ничего не знает.
    const at = pos.get(carrierId) ?? Number.POSITIVE_INFINITY
    if ((pos.get(ref) ?? 0) >= at) return ''
    // Скрытый логикой источник считается ПУСТЫМ — то же правило, по которому его ответ
    // не доезжает до сервера (stripHiddenAnswers) и не участвует в условиях.
    if (plan && !plan.visible.has(ref)) return ''
    return answerText(src, answers[ref])
  }
}

// Резолвер едет к выводу контекстом, а не пропом: RichText лежит под BlockField и
// реестром контролов, и протаскивание ответов через каждый тип поля означало бы правку
// сигнатур половины @fields ради одного потребителя. Ставят провайдер те, у кого ответы
// уже есть, — FormView у респондента и PreviewPane в превью.
//
// Провайдера НЕТ — значит поверхность не про заполнение (полотно редактора, диалог
// выбора типа): кусок печатается своим текстом, то есть именем вопроса. Пустота там
// была бы потерей текста на ровном месте.
export const MentionContext = createContext<MentionResolver | null>(null)

export const useMentionResolver = (): MentionResolver | null => useContext(MentionContext)
