import { useEffect, useReducer, useRef, useState } from 'react'

import { DEFAULT_SUBMIT_LABEL } from '@entities/formSchema'
import { type Answer } from '@fields/answer'
import { BlockField } from '@fields/BlockField'

import { type PublicForm, type SubmitOutcome, submitAnswers } from './api'
import { answersReducer, clearAnswers, loadAnswers, saveAnswers } from './answers'
import { uuidv7 } from './submissionId'
import { type Errors, validateAll, validateBlock } from './validation'

// Задержки перед повторами при обрыве сети (мс). До 3 повторов с нарастающим
// бэкоффом — DEV-PLAN фаза 5, шаг 6. Все повторы шлют один submission_id, поэтому
// сервер не создаёт дубля.
const retryBackoffMs = [400, 1200, 3000]

// submitWithRetry повторяет отправку только при сетевом исключении (fetch упал).
// Ответ сервера (в т.ч. 4xx/5xx) — это не обрыв: возвращается сразу, ретраить нечего.
async function submitWithRetry(
  slug: string,
  body: { submissionId: string; token: string; answers: Record<string, Answer> },
): Promise<SubmitOutcome> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await submitAnswers(slug, body)
    } catch (e) {
      if (attempt >= retryBackoffMs.length) throw e
      await new Promise((r) => setTimeout(r, retryBackoffMs[attempt]))
    }
  }
}

// Опубликованная форма как её видит и заполняет респондент. Поля — те же @fields,
// что и превью билдера, но в интерактивном режиме. Ответы в useReducer, черновик в
// sessionStorage, клиентская валидация (required/email/число/дата) по blur и на
// «Отправить», затем реальная отправка на сервер с идемпотентностью и авторетраем.
export function FormView({ slug, form }: { slug: string; form: PublicForm }) {
  const [answers, dispatch] = useReducer(answersReducer, null, () =>
    loadAnswers(slug, form.version),
  )
  const [errors, setErrors] = useState<Errors>({})
  const [attempted, setAttempted] = useState(false)
  const [phase, setPhase] = useState<'editing' | 'submitting' | 'done'>('editing')
  // notice — отказ отправки, не привязанный к полю (антиспам, закрытая форма, сеть).
  const [notice, setNotice] = useState<string | null>(null)

  // Один id на всё время жизни экрана: любые повторы (авто и ручные) идут под ним.
  const submissionId = useRef<string>('')
  // Защита от setState после размонтирования во время долгого ретрая. Флаг ставится
  // в true при монтировании и в false при размонтировании — под StrictMode (dev
  // делает mount→unmount→mount) инициализации useRef(true) недостаточно: cleanup
  // первого прохода обнулил бы флаг навсегда, и код после await молча не сработал бы.
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  useEffect(() => {
    saveAnswers(slug, form.version, answers)
  }, [slug, form.version, answers])

  const blocks = form.schema.blocks
  const submitLabel = form.schema.submitLabel?.trim() || DEFAULT_SUBMIT_LABEL
  const locked = phase !== 'editing'

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

  const onSubmit = async () => {
    if (locked) return
    setNotice(null)
    setAttempted(true)

    const found = validateAll(blocks, answers)
    setErrors(found)
    if (Object.keys(found).length > 0) return // сеть не трогаем, пока форма невалидна

    if (submissionId.current === '') submissionId.current = uuidv7()
    setPhase('submitting')

    let outcome: SubmitOutcome
    try {
      outcome = await submitWithRetry(slug, {
        submissionId: submissionId.current,
        token: form.token,
        answers,
      })
    } catch {
      if (!active.current) return
      setPhase('editing')
      setNotice('Не удалось отправить — проверьте соединение и попробуйте ещё раз.')
      return
    }
    if (!active.current) return

    switch (outcome.status) {
      case 'ok':
        clearAnswers(slug, form.version)
        setPhase('done')
        return
      case 'invalid':
        // Сервер — финальная инстанция: подсвечиваем присланные им поля.
        setErrors(outcome.fields)
        setPhase('editing')
        setNotice('Проверьте выделенные поля.')
        return
      case 'closed':
        setPhase('editing')
        setNotice('Форма больше не принимает ответы.')
        return
      case 'rejected':
        setPhase('editing')
        setNotice(outcome.message)
        return
    }
  }

  if (phase === 'done') {
    return (
      <main className="status">
        <h1 className="status-title">Спасибо!</h1>
        <p className="status-detail">Ваш ответ отправлен.</p>
      </main>
    )
  }

  const hasFieldErrors = Object.keys(errors).length > 0

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
            disabled={locked}
          />
        ))}
      </div>
      <button
        className="submit-btn"
        type="button"
        onClick={() => void onSubmit()}
        disabled={phase === 'submitting'}
      >
        {phase === 'submitting' ? 'Отправка…' : submitLabel}
      </button>
      {attempted && hasFieldErrors && (
        <p className="form-note form-note-error" role="alert">
          Проверьте выделенные поля.
        </p>
      )}
      {notice && !hasFieldErrors && (
        <p className="form-note form-note-error" role="alert">
          {notice}
        </p>
      )}
    </main>
  )
}
