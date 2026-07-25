import { useEffect, useReducer, useRef, useState } from 'react'

import { DEFAULT_SUBMIT_LABEL } from '@entities/formSchema'
import { type Answer } from '@fields/answer'
import { BlockField } from '@fields/BlockField'
import { groupBlocks, groupMeta, packRows } from '@fields/groups'

import { type PublicForm, type SubmitOutcome, submitAnswers } from './api'
import { answersReducer, clearAnswers, loadAnswers, saveAnswers } from './answers'
import { uuidv7 } from './submissionId'
import { ThankYou } from './ThankYou'
import { type Errors, validateAll, validateBlock } from './validation'
import { createVisitTracker, type VisitTracker } from './visits'

// Задержки перед повторами при обрыве сети (мс). До 3 повторов с нарастающим
// бэкоффом — DEV-PLAN фаза 5, шаг 6. Все повторы шлют один submission_id, поэтому
// сервер не создаёт дубля.
const retryBackoffMs = [400, 1200, 3000]

// submitWithRetry повторяет отправку только при сетевом исключении (fetch упал).
// Ответ сервера (в т.ч. 4xx/5xx) — это не обрыв: возвращается сразу, ретраить нечего.
async function submitWithRetry(
  slug: string,
  body: { submissionId: string; token: string; answers: Record<string, Answer>; visitId: string },
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
  // Подпись и обязательность на группу (v2): подпись → aria поля, обязательность →
  // звёздочка у блока-подписи.
  const groups = groupMeta(blocks)
  const submitLabel = form.schema.submitLabel?.trim() || DEFAULT_SUBMIT_LABEL
  const locked = phase !== 'editing'

  // Визит: «открыли» на монтировании, «дошёл до вопроса» на уходе со страницы.
  // Трекер создаётся лениво в ref, а не в эффекте: под StrictMode (dev делает
  // mount→unmount→mount) эффект выполнился бы дважды и дал два визита на одно
  // открытие. Флаг started намеренно НЕ сбрасывается в cleanup — «этот визит уже
  // посчитан» переживает повторное монтирование.
  const visit = useRef<VisitTracker | null>(null)
  if (visit.current === null) {
    visit.current = createVisitTracker(slug, form.token, form.version, window.location.search)
  }
  const started = useRef(false)
  // Самая дальняя точка визита: индекс последнего блока, которого коснулись.
  // Индекс, а не id, — сравнивать «дальше/ближе» можно только по порядку; наружу
  // всё равно уезжает id блока (переживёт многостраничные формы, ADR §10).
  const furthest = useRef(-1)

  useEffect(() => {
    const tracker = visit.current
    if (tracker === null) return
    if (!started.current) {
      started.current = true
      tracker.start()
    }

    const leave = () => {
      const block = furthest.current >= 0 ? blocks[furthest.current] : undefined
      tracker.leave(block?.id ?? null)
    }
    // pagehide ловит закрытие вкладки и переход по ссылке; visibilitychange —
    // сворачивание и переключение вкладки на мобильных, где pagehide может не
    // прийти вовсе. Оба шлют свой seq, сервер берёт наибольший.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') leave()
    }
    window.addEventListener('pagehide', leave)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', leave)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [blocks])

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
        visitId: visit.current?.id ?? '',
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
      <ThankYou
        text={form.schema.thankYouText ?? ''}
        redirectUrl={form.schema.redirectUrl ?? ''}
      />
    )
  }

  const hasFieldErrors = Object.keys(errors).length > 0

  return (
    <main className="rf-page">
      <h1 className="rf-title">{form.title.trim() || 'Форма'}</h1>
      <div className="rf-form">
        {packRows(groupBlocks(blocks)).map((row) => {
          // Вопрос — обёртка .rf-group: блоки одной группы стоят тесно (14px), между
          // группами простор (28px) — единый ритм с превью и редактором (этап 13.3).
          // Два соседних half-вопроса едут одним рядом .rf-row (фаза 13.6, спека §5);
          // обёртка ряда — только у настоящей пары.
          const groupNodes = row.map((group) => (
            <div key={group.id} className="rf-group">
              {group.blocks.map((block) => {
                // Индекс блока в полном потоке — для «самой дальней точки визита»
                // (furthest): группировка не меняет порядок, индекс берём из blocks.
                const index = blocks.indexOf(block)
                return (
                  // onFocusCapture на обёртке, а не новый проп у BlockField: поля общие
                  // с превью билдера, и заводить в них аналитику публичной страницы
                  // нельзя. Capture — фокус приходит на вложенный input, а не на div.
                  <div
                    key={block.id}
                    onFocusCapture={() => {
                      if (index > furthest.current) furthest.current = index
                    }}
                  >
                    <BlockField
                      block={block}
                      captionText={groups.get(block.groupId)?.caption}
                      captionRequired={groups.get(block.groupId)?.required}
                      value={answers[block.id]}
                      onChange={(value: Answer) => onChange(block.id, value)}
                      onBlur={() => onBlur(block.id)}
                      error={errors[block.id]}
                      disabled={locked}
                    />
                  </div>
                )
              })}
            </div>
          ))
          const first = row[0]
          if (!first) return null
          return row.length > 1 ? (
            <div key={first.id} className="rf-row">
              {groupNodes}
            </div>
          ) : (
            groupNodes[0]
          )
        })}
      </div>
      <button
        className="rf-submit"
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
