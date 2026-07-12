import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import type { Form } from '../../entities/form'
import { formatDate } from '../../shared/format'
import { useDeleteForm, useRenameForm } from './queries'

const statusLabels: Record<Form['status'], string> = {
  draft: 'Черновик',
  published: 'Опубликована',
  closed: 'Закрыта',
}

// FormCard — карточка формы: заголовок ведёт в редактор, инлайн-переименование
// и удаление с подтверждением. Правки формы — серверный стейт, идут через мутации
// (инвалидируют список), локален только UI-стейт режима редактирования.
export function FormCard({ form }: { form: Form }) {
  const [editing, setEditing] = useState(false)
  const rename = useRenameForm()
  const remove = useDeleteForm()

  function handleDelete() {
    if (window.confirm(`Удалить форму «${form.title}»? Это действие необратимо.`)) {
      remove.mutate(form.id)
    }
  }

  return (
    <article className="form-card" aria-busy={remove.isPending}>
      {editing ? (
        <RenameForm
          initial={form.title}
          pending={rename.isPending}
          onCancel={() => setEditing(false)}
          onSubmit={(title) =>
            rename.mutate({ id: form.id, title }, { onSuccess: () => setEditing(false) })
          }
        />
      ) : (
        <Link to="/forms/$formId/edit" params={{ formId: form.id }} className="form-card-title">
          {form.title}
        </Link>
      )}

      <div className="form-card-meta">
        <span className={`form-badge form-badge-${form.status}`}>{statusLabels[form.status]}</span>
        <span className="form-card-date">Изменена {formatDate(form.updatedAt)}</span>
      </div>

      {!editing && (
        <div className="form-card-actions">
          <Link to="/forms/$formId/responses" params={{ formId: form.id }}>
            Ответы ({form.submissionCount})
          </Link>
          <button type="button" onClick={() => setEditing(true)}>
            Переименовать
          </button>
          <button
            type="button"
            className="danger"
            onClick={handleDelete}
            disabled={remove.isPending}
          >
            {remove.isPending ? 'Удаляем…' : 'Удалить'}
          </button>
        </div>
      )}
    </article>
  )
}

// RenameForm — инлайн-редактор названия. Пустое название не отправляем (совпадает
// с серверной валидацией: title обязателен).
function RenameForm({
  initial,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: string
  pending: boolean
  onSubmit: (title: string) => void
  onCancel: () => void
}) {
  const [title, setTitle] = useState(initial)
  const trimmed = title.trim()

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (trimmed) onSubmit(trimmed)
  }

  return (
    <form onSubmit={handleSubmit} className="form-rename">
      <label htmlFor={`rename-${initial}`} className="visually-hidden">
        Название формы
      </label>
      <input
        id={`rename-${initial}`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
        maxLength={200}
      />
      <div className="form-rename-actions">
        <button type="submit" disabled={pending || !trimmed}>
          {pending ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button type="button" onClick={onCancel} disabled={pending}>
          Отмена
        </button>
      </div>
    </form>
  )
}
