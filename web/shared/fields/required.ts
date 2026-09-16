import { type Block, isContentType } from '@entities/formSchema'

import { type Answer } from './answer'

// Пустой ответ — «не отвечено». Одно правило на проверку поля рендерера (validation.ts) и
// на доступность кнопки отправки у формы и превью: разойдись они, кнопка давалась бы там,
// где проверка тут же скажет «Обязательное поле», или гасла бы на заполненной форме.
export function isEmptyAnswer(value: Answer | undefined): boolean {
  if (value == null || value === '') return true
  return Array.isArray(value) && value.length === 0
}

// missingRequired — у ВИДИМЫХ блоков есть пустой обязательный. `blocks` — то, что человек
// видит (плоский план страниц), `required` — фактически обязательные из плана: скрытый
// условием вопрос не спрашивали, и держать кнопку из-за него значило бы запереть форму.
// Формат (email, число) сюда не входит — он проверяется нажатием и расфокусом.
export function missingRequired(
  blocks: readonly Block[],
  answers: Readonly<Record<string, Answer>>,
  required: ReadonlySet<string>,
): boolean {
  return blocks.some(
    (b) => !isContentType(b.type) && required.has(b.id) && isEmptyAnswer(answers[b.id]),
  )
}
