import { type Block } from '@entities/formSchema'

import { type Answer, optionKey, toggleMulti } from '../answer'
import { packOptionRows } from '../groups'

// Список вариантов: радиокнопки для одиночного выбора, чекбоксы для множественного. Общий
// для single_choice и multi_choice — разница между ними в ОДНОМ бите (multiple), и
// развести их по двум копиям значило бы, что правка ряда вариантов или буквенного бейджа
// в одной копии не видна в другой. Кардинальность объявляют файлы типов; здесь она флаг.
//
// Без вариантов — заметка вместо пустоты (в черновике это норма). Управляемый: checked
// считается из value, изменение — через onChange (в multi массив правит toggleMulti).
export function ChoiceList({
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
  // Буквенный бейдж и состояние выбора считаются по позиции в ПОЛНОМ списке, а не внутри
  // ряда: порядок документа рядами не меняется (спека §5.1), и A/B/C обязаны остаться
  // теми же, что до переноса варианта в ряд.
  const card = (o: (typeof options)[number], i: number) => {
    const checked = multiple ? selectedMany.includes(o.id) : selectedOne === o.id
    const key = optionKey(i)
    return (
      // Состояние выбора — классом от React, а не CSS-селектором :has(:checked): класс
      // работает одинаково во всех браузерах и виден в тестах.
      //
      // Множественный выбор — обычные чекбоксы: сам глиф видим, карточки и буквы нет
      // (fields.css, .rf-option--check). Одиночный остаётся карточкой с буквой, и
      // настоящий radio у него спрятан — вид карточке даёт rf-option--on.
      <label
        key={o.id}
        className={`rf-option${multiple ? ' rf-option--check' : ''}${checked ? ' rf-option--on' : ''}`}
      >
        <input
          className={multiple ? 'rf-mark rf-mark--check' : 'rf-choice-input'}
          type={multiple ? 'checkbox' : 'radio'}
          name={block.id}
          checked={checked}
          onChange={(e) => onToggle(o.id, e.target.checked)}
          disabled={disabled}
        />
        {!multiple && key && (
          <span className="rf-option-key" aria-hidden="true">
            {key}
          </span>
        )}
        <span>{o.label.trim() || 'Вариант'}</span>
      </label>
    )
  }
  // Ряды вариантов (спека §5.1) — тот же раскладчик и та же обёртка .rf-row, что у
  // вопросов; ряд из одного в обёртку не заворачивается.
  const index = new Map(options.map((o, i) => [o.id, i]))
  return (
    <div className="rf-options" role="group" aria-label="Варианты ответа" onBlur={onBlur}>
      {packOptionRows(options).map((row) => {
        const first = row[0]![0]!
        // Ряд из двоих — две ячейки .rf-cell по половине колонки; карточка внутри обнимает
        // текст, но начинается там, где ячейка (правая — с середины). В правой ячейке
        // может стоять СТОПКА вариантов — тот же раскладчик, что у вопросов (§5).
        return row.length > 1 ? (
          <div key={first.id} className="rf-row">
            {row.map((cell) => (
              <div key={cell[0]!.id} className="rf-cell">
                {cell.map((o) => card(o, index.get(o.id)!))}
              </div>
            ))}
          </div>
        ) : (
          card(first, index.get(first.id)!)
        )
      })}
    </div>
  )
}
