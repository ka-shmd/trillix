import { useEffect, useRef, useState } from 'react'

import { toggleMulti } from '../answer'
import { type Control } from './contract'

// Число цветов плашек — классы rf-tag--c0…c7 в fields.css.
const TAG_COLORS = 8

// Цвет плашки — по позиции варианта в списке блока: один и тот же в поле и в списке.
const tagClass = (index: number) => `rf-tag rf-tag--c${index % TAG_COLORS}`

// Теги: несколько вариантов из выпадающего списка. Поле — тот же rf-input с шевроном,
// выбранные варианты встают в него цветными плашками, ввод текста сужает список. Список
// рисуем сами: у нативного <select multiple> выбор на десктопе — Ctrl+клик, и плашек
// в нём нет.
//
// В списке только НЕВЫБРАННЫЕ варианты: выбранный уже стоит в поле, а убирается крестиком
// плашки или Backspace. Отметок выбора в списке поэтому нет вовсе.
//
// Клавиатура (фокус всё время в строке поиска): ↑↓ — активный пункт (открывают закрытый
// список), Enter — добавить активный, Esc — закрыть, Backspace на пустой строке — убрать
// последний тег. Список после выбора НЕ закрывается: тегов обычно несколько.
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
  const indexOf = new Map(options.map((o, i) => [o.id, i]))
  const chosen = selected.flatMap((id) => {
    const i = indexOf.get(id)
    return i === undefined ? [] : [{ option: options[i]!, index: i }]
  })
  const available = options.filter((o) => !selected.includes(o.id))
  const needle = query.trim().toLowerCase()
  const filtered =
    needle === '' ? available : available.filter((o) => labelOf(o.label).toLowerCase().includes(needle))
  const at = Math.min(active, Math.max(filtered.length - 1, 0))
  const showList = open && !inert

  useEffect(() => {
    if (!showList) return
    document.getElementById(`${listId}-${at}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [showList, at, listId])

  if (options.length === 0) {
    return <p className="rf-empty">Варианты пока не добавлены</p>
  }

  const add = (id: string) => {
    p.onChange?.(toggleMulti(selected, id, true))
    setQuery('')
    setActive(0)
  }
  const remove = (id: string) => p.onChange?.(toggleMulti(selected, id, false))
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
        add(target.id)
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
          remove(last)
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
          setOpen((was) => !was)
        }}
      >
        {chosen.map(({ option, index }) => (
          <span key={option.id} className={tagClass(index)}>
            <span className="rf-tag-text">{labelOf(option.label)}</span>
            {!inert && (
              <button
                type="button"
                className="rf-tag-remove"
                tabIndex={-1}
                aria-label={`Убрать «${labelOf(option.label)}»`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={() => remove(option.id)}
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
        {!p.readOnly && (
          <svg className="rf-tags-chevron" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
          </svg>
        )}
      </div>
      {showList && (
        <ul id={listId} className="rf-tags-list" role="listbox" aria-multiselectable="true">
          {filtered.length === 0 ? (
            <li className="rf-tags-empty">
              {available.length === 0 ? 'Все варианты выбраны' : 'Ничего не найдено'}
            </li>
          ) : (
            filtered.map((o, i) => (
              <li
                key={o.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={false}
                className={`rf-tags-option${i === at ? ' rf-tags-option--active' : ''}`}
                onMouseDown={keepFocus}
                onMouseEnter={() => setActive(i)}
                onClick={() => add(o.id)}
              >
                <span className={tagClass(indexOf.get(o.id)!)}>
                  <span className="rf-tag-text">{labelOf(o.label)}</span>
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
