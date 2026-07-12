import { useEffect, useReducer, useState } from 'react'

import { type Answer } from '@fields/answer'
import { BlockField } from '@fields/BlockField'

import { type PublicForm } from './api'
import { answersReducer, loadAnswers, saveAnswers } from './answers'
import { type Errors, validateAll, validateBlock } from './validation'

// Опубликованная форма как её видит и заполняет респондент. Поля — те же @fields,
// что и превью билдера, но в интерактивном режиме. Ответы в useReducer, черновик
// в sessionStorage, клиентская валидация (required/email/число/дата) по blur и на
// «Отправить». Реальная отправка — фаза 5; пока валидная форма пишется в консоль.
export function FormView({ slug, form }: { slug: string; form: PublicForm }) {
  const [answers, dispatch] = useReducer(answersReducer, null, () => loadAnswers(slug, form.version))
  const [errors, setErrors] = useState<Errors>({})
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    saveAnswers(slug, form.version, answers)
  }, [slug, form.version, answers])

  const blocks = form.schema.blocks

  const setBlockError = (blockId: string, msg: string | null) =>
    setErrors((prev) => {
      if (msg === null) {
        if (!(blockId in prev)) return prev
        const next = { ...prev }
        delete next[blockId]
        return next
      }
      return { ...prev, [blockId]: msg }
    })

  const onChange = (blockId: string, value: Answer) => {
    dispatch({ type: 'set', blockId, value })
    // Уже показанную ошибку пересчитываем на лету, чтобы она гасла по мере
    // исправления; чистое поле ошибкой не «пугаем» до blur/отправки.
    if (blockId in errors) {
      const block = blocks.find((b) => b.id === blockId)
      if (block) setBlockError(blockId, validateBlock(block, value))
    }
  }

  const onBlur = (blockId: string) => {
    const block = blocks.find((b) => b.id === blockId)
    if (block) setBlockError(blockId, validateBlock(block, answers[blockId]))
  }

  const onSubmit = () => {
    const found = validateAll(blocks, answers)
    setErrors(found)
    setSubmitted(true)
    if (Object.keys(found).length === 0) {
      // Отправка на сервер появится в фазе 5; пока подтверждаем готовность.
      console.info('форма заполнена верно, ответы:', answers)
    }
  }

  const hasErrors = Object.keys(errors).length > 0

  return (
    <main className="page">
      <h1 className="form-title">{form.title.trim() || 'Форма'}</h1>
      <div className="rf-form">
        {blocks.map((block) => (
          <BlockField
            key={block.id}
            block={block}
            value={answers[block.id]}
            onChange={(value: Answer) => onChange(block.id, value)}
            onBlur={() => onBlur(block.id)}
            error={errors[block.id]}
            disabled={false}
          />
        ))}
      </div>
      <button className="submit-btn" type="button" onClick={onSubmit}>
        Отправить
      </button>
      {submitted && hasErrors && (
        <p className="form-note form-note-error" role="alert">
          Проверьте выделенные поля.
        </p>
      )}
      {submitted && !hasErrors && (
        <p className="form-note">Форма заполнена верно. Отправка ответов появится в следующей версии.</p>
      )}
    </main>
  )
}
