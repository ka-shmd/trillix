import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useBuilderStore } from './storeContext'
import { BlockRow } from './BlockRow'
import { useRenameForm } from '../queries'
import { DEFAULT_FORM_TITLE } from '../../../entities/form'

// SlashEditor — полотно редактора: название формы первой строкой, ниже блоки как
// редактируемые строки. Фокусом между строками управляет focusId (после Enter/
// удаления/навигации редактор просит нужную строку сфокусироваться). Стор, автосейв
// и превью — прежние (фаза 3); переписана только поверхность ввода.
export function SlashEditor({ formId, initialTitle }: { formId: string; initialTitle: string }) {
  const blocks = useBuilderStore((s) => s.blocks)
  const addBlockAfter = useBuilderStore((s) => s.addBlockAfter)
  const removeBlock = useBuilderStore((s) => s.removeBlock)
  const [focusId, setFocusId] = useState<string | null>(null)

  function focusFirstOrCreate() {
    const first = blocks[0]
    setFocusId(first ? first.id : addBlockAfter(null, 'short_text'))
  }

  function handleAddBelow(id: string) {
    setFocusId(addBlockAfter(id, 'short_text'))
  }

  function handleBackspaceEmpty(id: string) {
    const i = blocks.findIndex((b) => b.id === id)
    const prev = blocks[i - 1]
    removeBlock(id)
    if (prev) setFocusId(prev.id)
  }

  function handleArrow(id: string, dir: 'up' | 'down') {
    const i = blocks.findIndex((b) => b.id === id)
    const neighbor = dir === 'up' ? blocks[i - 1] : blocks[i + 1]
    if (neighbor) setFocusId(neighbor.id)
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <FormTitleInput formId={formId} initialTitle={initialTitle} onEnter={focusFirstOrCreate} />

      {blocks.length === 0 ? (
        <button
          type="button"
          onClick={() => setFocusId(addBlockAfter(null, 'short_text'))}
          className="mt-6 block w-full pl-9 text-left text-base text-muted-foreground/50 hover:text-muted-foreground"
        >
          Напишите вопрос или «/» для выбора типа поля
        </button>
      ) : (
        <ol className="mt-6 flex flex-col gap-0.5">
          {blocks.map((b, i) => (
            <BlockRow
              key={b.id}
              block={b}
              index={i}
              total={blocks.length}
              focusMe={focusId === b.id}
              onFocusHandled={() => setFocusId(null)}
              onAddBelow={handleAddBelow}
              onBackspaceEmpty={handleBackspaceEmpty}
              onArrow={handleArrow}
            />
          ))}
        </ol>
      )}

      {blocks.length > 0 && (
        <button
          type="button"
          onClick={() => setFocusId(addBlockAfter(blocks[blocks.length - 1]?.id ?? null, 'short_text'))}
          className="mt-2 pl-2 text-left text-sm text-muted-foreground hover:text-foreground"
        >
          + Добавить вопрос
        </button>
      )}
    </div>
  )
}

// FormTitleInput — название формы как первая строка полотна. Пишет в forms.title
// (отдельная колонка БД, не блок схемы) дебаунс-PATCH'ем через useRenameForm.
// Пустое название не отправляем (совпадает с серверной валидацией: title обязателен).
function FormTitleInput({
  formId,
  initialTitle,
  onEnter,
}: {
  formId: string
  initialTitle: string
  onEnter: () => void
}) {
  const rename = useRenameForm()
  // Дефолтное имя показываем пустым полем → виден плейсхолдер.
  const [title, setTitle] = useState(initialTitle === DEFAULT_FORM_TITLE ? '' : initialTitle)
  const lastSaved = useRef(initialTitle)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  function onChange(value: string) {
    setTitle(value)
    if (timer.current) clearTimeout(timer.current)
    const trimmed = value.trim()
    if (!trimmed || trimmed === lastSaved.current) return
    timer.current = setTimeout(() => {
      rename.mutate(
        { id: formId, title: trimmed },
        { onSuccess: () => (lastSaved.current = trimmed) },
      )
    }, 800)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault()
      onEnter()
    }
  }

  return (
    <input
      value={title}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder="Без названия"
      aria-label="Название формы"
      className="mb-2 w-full bg-transparent pl-9 text-4xl font-bold tracking-tight outline-none placeholder:text-muted-foreground/40"
    />
  )
}
