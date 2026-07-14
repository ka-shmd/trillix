import { type ChangeEvent } from 'react'

import { type Block, isContentType } from '@entities/formSchema'

import { type Answer, toggleMulti } from './answer'
import { FieldShell } from './FieldShell'

// BlockField — как один блок увидит человек, заполняющий форму. Два режима одним
// кодом (не разъезжаться — web/CLAUDE.md):
//   • превью билдера — без value/onChange, disabled по умолчанию: контролы видны,
//     но не редактируются (PreviewPane зовёт <BlockField block={block} />);
//   • рендерер — disabled={false} + управляемые value/onChange (фаза 4).
// Диспетчер по block.type; switch исчерпывающий (все семь типов возвращают значение).
type BlockFieldProps = {
  block: Block
  value?: Answer
  onChange?: (next: Answer) => void
  disabled?: boolean
  // Рендерер: сообщение об ошибке валидации и колбэк потери фокуса (проверка по
  // blur). В превью билдера отсутствуют — поле ведёт себя как раньше.
  error?: string
  onBlur?: () => void
}

export function BlockField({ block, value, onChange, disabled = true, error, onBlur }: BlockFieldProps) {
  // Неотвечаемый блок (text) — статический абзац: без подписи-вопроса, звёздочки,
  // контрола и ошибок. Пустой текст в черновике не показываем.
  if (isContentType(block.type)) {
    return block.label.trim() ? <p className="rf-text">{block.label}</p> : null
  }

  const errorId = error ? `${block.id}-error` : undefined
  return (
    <FieldShell block={block} error={error} errorId={errorId}>
      <FieldControl
        block={block}
        value={value}
        onChange={onChange}
        disabled={disabled}
        invalid={!!error}
        errorId={errorId}
        onBlur={onBlur}
      />
    </FieldShell>
  )
}

type ControlProps = {
  block: Block
  value?: Answer
  onChange?: (next: Answer) => void
  disabled: boolean
  invalid: boolean
  errorId?: string
  onBlur?: () => void
}

function FieldControl({ block, value, onChange, disabled, invalid, errorId, onBlur }: ControlProps) {
  const label = block.label.trim() || 'Без названия'
  // Текстовые контролы управляемые: пустая строка вместо undefined, чтобы React
  // не переключал input между controlled/uncontrolled. onChange присутствует
  // всегда (иначе React ругается на value без onChange); в превью не срабатывает.
  const text = typeof value === 'string' ? value : ''
  // Плейсхолдер поля из настроек (автор задаёт его в билдере); пусто → undefined.
  const ph = block.settings?.placeholder?.trim() || undefined
  const onText = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange?.(e.target.value)
  // Общие a11y-атрибуты текстовых полей: пометка невалидности и связь с
  // сообщением об ошибке. undefined убирает атрибут в валидном состоянии.
  const invalidProps = {
    'aria-invalid': invalid || undefined,
    'aria-describedby': invalid ? errorId : undefined,
    onBlur,
  }

  switch (block.type) {
    case 'short_text':
      return (
        <input
          className="rf-input"
          type="text"
          value={text}
          onChange={onText}
          disabled={disabled}
          aria-label={label}
          placeholder={ph}
          {...invalidProps}
        />
      )
    case 'long_text':
      return (
        <textarea
          className="rf-input"
          rows={3}
          value={text}
          onChange={onText}
          disabled={disabled}
          aria-label={label}
          placeholder={ph}
          {...invalidProps}
        />
      )
    case 'email':
      return (
        <input
          className="rf-input"
          type="email"
          value={text}
          onChange={onText}
          disabled={disabled}
          aria-label={label}
          placeholder={ph ?? 'you@example.com'}
          {...invalidProps}
        />
      )
    case 'number':
      return (
        <input
          className="rf-input"
          type="number"
          value={text}
          onChange={onText}
          disabled={disabled}
          aria-label={label}
          placeholder={ph}
          {...invalidProps}
        />
      )
    case 'date':
      return (
        <input
          className="rf-input"
          type="date"
          value={text}
          onChange={onText}
          disabled={disabled}
          aria-label={label}
          {...invalidProps}
        />
      )
    case 'single_choice':
      return (
        <ChoiceList block={block} multiple={false} value={value} onChange={onChange} disabled={disabled} onBlur={onBlur} />
      )
    case 'multi_choice':
      return (
        <ChoiceList block={block} multiple={true} value={value} onChange={onChange} disabled={disabled} onBlur={onBlur} />
      )
    case 'text':
      // Неотвечаемый блок обрабатывается в BlockField до FieldShell; сюда не
      // доходит — ветка для исчерпывающести switch по типам.
      return null
  }
}

// Список вариантов choice-блока: радиокнопки для одиночного выбора, чекбоксы для
// множественного. Без вариантов — заметка вместо пустоты (в черновике это норма).
// Управляемый: checked считается из value, изменение — через onChange (в multi
// массив правит toggleMulti).
function ChoiceList({
  block,
  multiple,
  value,
  onChange,
  disabled,
  onBlur,
}: {
  block: Block
  multiple: boolean
  value?: Answer
  onChange?: (next: Answer) => void
  disabled: boolean
  onBlur?: () => void
}) {
  const options = block.settings?.options ?? []
  if (options.length === 0) {
    return <p className="rf-empty">Варианты пока не добавлены</p>
  }
  const selectedMany = Array.isArray(value) ? value : []
  const selectedOne = typeof value === 'string' ? value : ''
  const onToggle = (id: string, checked: boolean) => {
    if (!onChange) return
    onChange(multiple ? toggleMulti(selectedMany, id, checked) : id)
  }
  return (
    <div className="rf-options" role="group" aria-label={block.label.trim() || 'Без названия'} onBlur={onBlur}>
      {options.map((o) => {
        const checked = multiple ? selectedMany.includes(o.id) : selectedOne === o.id
        return (
          <label key={o.id} className="rf-option">
            <input
              className={multiple ? 'rf-mark rf-mark--check' : 'rf-mark rf-mark--radio'}
              type={multiple ? 'checkbox' : 'radio'}
              name={block.id}
              checked={checked}
              onChange={(e) => onToggle(o.id, e.target.checked)}
              disabled={disabled}
            />
            <span>{o.label.trim() || 'Вариант'}</span>
          </label>
        )
      })}
    </div>
  )
}
