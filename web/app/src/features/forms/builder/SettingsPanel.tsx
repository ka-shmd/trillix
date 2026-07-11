import { type Block, isChoiceType } from '@entities/formSchema'

import { blockTypeLabel } from './blockTypes'
import { useBuilderStore } from './storeContext'

// Панель настроек выделенного блока: обязательность и типоспецифика (для choice —
// редактор опций). label/description правятся на канвасе, не здесь.
export function SettingsPanel() {
  const selected = useBuilderStore((s) => s.blocks.find((b) => b.id === s.selectedId) ?? null)
  const updateBlock = useBuilderStore((s) => s.updateBlock)

  return (
    <aside className="builder-pane builder-settings" aria-label="Настройки блока">
      <h2 className="builder-pane-title">Настройки</h2>
      {selected ? (
        <div className="settings-body">
          <p className="settings-type">{blockTypeLabel(selected.type)}</p>
          <label className="settings-required">
            <input
              type="checkbox"
              checked={selected.required ?? false}
              onChange={(e) => updateBlock(selected.id, { required: e.target.checked })}
            />
            Обязательный вопрос
          </label>
          {isChoiceType(selected.type) && <OptionsEditor block={selected} />}
        </div>
      ) : (
        <p className="builder-hint">Выберите блок на канвасе, чтобы увидеть его настройки.</p>
      )}
    </aside>
  )
}

function OptionsEditor({ block }: { block: Block }) {
  const addOption = useBuilderStore((s) => s.addOption)
  const updateOption = useBuilderStore((s) => s.updateOption)
  const removeOption = useBuilderStore((s) => s.removeOption)
  const moveOption = useBuilderStore((s) => s.moveOption)

  const options = block.settings?.options ?? []

  return (
    <div className="options-editor">
      <h3 className="options-title">Варианты</h3>
      {options.length === 0 ? (
        <p className="builder-hint">Пока нет вариантов.</p>
      ) : (
        <ol className="options-list">
          {options.map((o, i) => (
            <li key={o.id} className="option-row">
              <input
                className="option-input"
                value={o.label}
                placeholder="Вариант"
                aria-label={`Вариант ${i + 1}`}
                onChange={(e) => updateOption(block.id, o.id, e.target.value)}
              />
              <div className="option-actions">
                <button
                  type="button"
                  aria-label="Переместить вверх"
                  disabled={i === 0}
                  onClick={() => moveOption(block.id, o.id, 'up')}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label="Переместить вниз"
                  disabled={i === options.length - 1}
                  onClick={() => moveOption(block.id, o.id, 'down')}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="option-remove"
                  aria-label="Удалить вариант"
                  onClick={() => removeOption(block.id, o.id)}
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <button type="button" className="option-add" onClick={() => addOption(block.id)}>
        + Добавить вариант
      </button>
    </div>
  )
}
