import { blockTypeLabel } from './blockTypes'
import { useBuilderStore } from './storeContext'

// Панель настроек выделенного блока. В шаге 4 — только каркас: показывает, какой
// блок выбран. Редактирование (label/description, required, опции choice) придёт
// в шаге 5, автосейв — в шаге 6.
export function SettingsPanel() {
  const selected = useBuilderStore((s) => s.blocks.find((b) => b.id === s.selectedId) ?? null)

  return (
    <aside className="builder-pane builder-settings" aria-label="Настройки блока">
      <h2 className="builder-pane-title">Настройки</h2>
      {selected ? (
        <dl className="settings-meta">
          <div>
            <dt>Тип</dt>
            <dd>{blockTypeLabel(selected.type)}</dd>
          </div>
          <div>
            <dt>Название</dt>
            <dd>{selected.label || '(без названия)'}</dd>
          </div>
          <p className="builder-hint">Редактирование появится на следующем шаге.</p>
        </dl>
      ) : (
        <p className="builder-hint">Выберите блок на канвасе, чтобы увидеть его настройки.</p>
      )}
    </aside>
  )
}
