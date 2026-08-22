import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// RenameForm — инлайн-редактор названия формы (карточка дашборда и строка списка
// пространств). Правит ВНУТРЕННЕЕ имя (name), не публичный заголовок. Пустое
// название не отправляем (совпадает с серверной валидацией: title обязателен).
export function RenameForm({
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label htmlFor={`rename-${initial}`} className="sr-only">
        Название формы
      </label>
      <Input
        id={`rename-${initial}`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
        maxLength={200}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || !trimmed}>
          {pending ? 'Сохраняем…' : 'Сохранить'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Отмена
        </Button>
      </div>
    </form>
  )
}
