import { useEffect, useReducer } from 'react'

import { type Answer } from '@fields/answer'
import { BlockField } from '@fields/BlockField'

import { type PublicForm } from './api'
import { answersReducer, loadAnswers, saveAnswers } from './answers'

// Опубликованная форма как её видит и заполняет респондент. Поля — те же @fields,
// что и превью билдера, но в интерактивном режиме (disabled={false}). Ответы в
// useReducer, черновик — в sessionStorage. Отправка появится в фазе 5; пока
// кнопка выключена.
export function FormView({ slug, form }: { slug: string; form: PublicForm }) {
  const [answers, dispatch] = useReducer(answersReducer, null, () => loadAnswers(slug, form.version))

  useEffect(() => {
    saveAnswers(slug, form.version, answers)
  }, [slug, form.version, answers])

  return (
    <main className="page">
      <h1 className="form-title">{form.title.trim() || 'Форма'}</h1>
      <div className="rf-form">
        {form.schema.blocks.map((block) => (
          <BlockField
            key={block.id}
            block={block}
            value={answers[block.id]}
            onChange={(value: Answer) => dispatch({ type: 'set', blockId: block.id, value })}
            disabled={false}
          />
        ))}
      </div>
      <button className="submit-btn" type="button" disabled title="Отправка ответов появится в фазе 5">
        Отправить · скоро
      </button>
    </main>
  )
}
