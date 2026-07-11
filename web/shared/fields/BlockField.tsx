import { type Block } from '@entities/formSchema'

import { FieldShell } from './FieldShell'

// BlockField — как один блок увидит человек, заполняющий форму. Пока это превью:
// контролы отрисованы, но выключены (disabled) — ввод и отправку добавит фаза 4,
// переиспользуя этот же компонент в рендерере. Диспетчер по block.type;
// switch исчерпывающий (все семь типов возвращают значение).
export function BlockField({ block }: { block: Block }) {
  return (
    <FieldShell block={block}>
      <FieldControl block={block} />
    </FieldShell>
  )
}

function FieldControl({ block }: { block: Block }) {
  const label = block.label.trim() || 'Без названия'
  switch (block.type) {
    case 'short_text':
      return <input className="rf-input" type="text" disabled aria-label={label} />
    case 'long_text':
      return <textarea className="rf-input" rows={3} disabled aria-label={label} />
    case 'email':
      return (
        <input
          className="rf-input"
          type="email"
          disabled
          aria-label={label}
          placeholder="you@example.com"
        />
      )
    case 'number':
      return <input className="rf-input" type="number" disabled aria-label={label} />
    case 'date':
      return <input className="rf-input" type="date" disabled aria-label={label} />
    case 'single_choice':
      return <ChoiceList block={block} multiple={false} />
    case 'multi_choice':
      return <ChoiceList block={block} multiple={true} />
  }
}

// Список вариантов choice-блока: радиокнопки для одиночного выбора, чекбоксы для
// множественного. Без вариантов — заметка вместо пустоты (в черновике это норма).
function ChoiceList({ block, multiple }: { block: Block; multiple: boolean }) {
  const options = block.settings?.options ?? []
  if (options.length === 0) {
    return <p className="rf-empty">Варианты пока не добавлены</p>
  }
  return (
    <div className="rf-options" role="group" aria-label={block.label.trim() || 'Без названия'}>
      {options.map((o) => (
        <label key={o.id} className="rf-option">
          <input type={multiple ? 'checkbox' : 'radio'} name={block.id} disabled />
          <span>{o.label.trim() || 'Вариант'}</span>
        </label>
      ))}
    </div>
  )
}
