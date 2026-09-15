import { useEffect, useRef, useState } from 'react'

import { toggleMulti } from '../answer'
import { type Control } from './contract'

// Теги: несколько вариантов из выпадающего списка. Поле — тот же rf-input, выбранные
// варианты встают в него плашками, ввод текста сужает список. Список рисуем сами:
// у нативного <select multiple> выбор на десктопе — Ctrl+клик, и плашек в нём нет.
//
// Клавиатура (фокус всё время в строке поиска): ↑↓ — активный пункт (открывают закрытый
// список), Enter — выбрать или снять активный, Esc — закрыть, Backspace на пустой строке —
// убрать последний тег. Список после выбора НЕ закрывается: тегов обычно несколько.
//
// ⚠ Пункты и крестики гасят mousedown (preventDefault): иначе нажатие мышью уводит фокус
// из строки поиска, обёртка ловит focusout и закрывает список раньше, чем придёт click.
//
// Порядок плашек — порядок выбора (так растёт массив в toggleMulti), а не порядок
// вариантов. id варианта, которого в блоке нет (ответ другой версии), плашкой не рисуется.
export const multiSelectControl: Control = (p) => {
  const options = p.block.settings?.options ?? []
  const selected = Array.isArray(p.value) ? p.value : []
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const listId = `${p.block.id}-tags`
  const inert = p.disabled || p.readOnly === true
  const labelOf = (label: string) => label.trim() || 'Вариант'
  const byId = new Map(options.map((o) => [o.id, o]))
  const chosen = selected.flatMap((id) => {
    const o = byId.get(id)
    return o ? [o] : []
  })
  const needle = query.trim().toLowerCase()
  const filtered = needle === '' ? options : options.filter((o) => labelOf(o.label).toLowerCase().includes(needle))
  const at = Math.min(active, Math.max(filtered.length - 1, 0))
  const showList = open && !inert

  useEffect(() => {
    if (!showList) return
    document.getElementById(`${listId}-${at}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [showList, at, listId])

  if (options.length === 0) {
    return <p className="rf-empty">Варианты пока не добавлены</p>
  }

  const toggle = (id: string) => {
    p.onChange?.(toggleMulti(selected, id, !selected.includes(id)))
    setQuery('')
    setActive(0)
  }
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault()
        if (!open) {
          setOpen(true)
          return
        }
        if (filtered.length === 0) return
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActive((at + step + filtered.length) % filtered.length)
        return
      }
      case 'Enter': {
        const target = filtered[at]
        if (!open || !target) return
        // Иначе Enter в поле отправил бы форму.
        e.preventDefault()
        toggle(target.id)
        return
      }
      case 'Escape':
        if (open) {
          e.preventDefault()
          setOpen(false)
        }
        return
      case 'Backspace': {
        const last = selected[selected.length - 1]
        if (query === '' && last !== undefined) {
          e.preventDefault()
          p.onChange?.(selected.slice(0, -1))
        }
        return
      }
    }
  }

  return (
    <div
      className="rf-tags"
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setOpen(false)
        setQuery('')
        p.onBlur?.()
      }}
    >
      <div
        className={`rf-input rf-tags-field${inert ? ' rf-tags-field--inert' : ''}`}
        onMouseDown={(e) => {
          if (inert || e.target === inputRef.current) return
          e.preventDefault()
          inputRef.current?.focus()
          setOpen(true)
        }}
      >
        {chosen.map((o) => (
          <span key={o.id} className="rf-tag">
            <span className="rf-tag-text">{labelOf(o.label)}</span>
            {!inert && (
              <button
                type="button"
                className="rf-tag-remove"
                tabIndex={-1}
                aria-label={`Убрать «${labelOf(o.label)}»`}
                onMouseDown={keepFocus}
                onClick={() => toggle(o.id)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                </svg>
              </button>
            )}
          </span>
        ))}
        {!p.readOnly && (
          <input
            ref={inputRef}
            className="rf-tags-input"
            role="combobox"
            aria-label={p.label}
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList && filtered[at] ? `${listId}-${at}` : undefined}
            aria-invalid={p.invalid || undefined}
            aria-describedby={p.invalid ? p.errorId : undefined}
            value={query}
            placeholder={chosen.length > 0 ? '' : 'Выберите варианты'}
            disabled={p.disabled}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={onKeyDown}
          />
        )}
      </div>
      {showList && (
        <ul id={listId} className="rf-tags-list" role="listbox" aria-multiselectable="true">
          {filtered.length === 0 ? (
            <li className="rf-tags-empty">Ничего не найдено</li>
          ) : (
            filtered.map((o, i) => {
              const on = selected.includes(o.id)
              return (
                <li
                  key={o.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={on}
                  className={`rf-tags-option${i === at ? ' rf-tags-option--active' : ''}`}
                  onMouseDown={keepFocus}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => toggle(o.id)}
                >
                  <span className={`rf-mark rf-mark--check${on ? ' rf-mark--on' : ''}`} aria-hidden="true" />
                  <span>{labelOf(o.label)}</span>
                </li>
              )
            })
          )}
        </ul>
      )}
    </div>
  )
}
