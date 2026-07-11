import { blockTypeLabel } from './blockTypes'
import { useBuilderStore } from './storeContext'

// Канвас — упорядоченный список блоков формы. Клик по блоку выделяет его (правка
// содержимого — шаг 5, перемещение — шаг 7). Пустой канвас показывает подсказку.
export function Canvas() {
  const blocks = useBuilderStore((s) => s.blocks)
  const selectedId = useBuilderStore((s) => s.selectedId)
  const select = useBuilderStore((s) => s.select)

  if (blocks.length === 0) {
    return (
      <section className="builder-pane builder-canvas" aria-label="Форма">
        <div className="canvas-empty">
          <p>Пусто. Добавьте блок из палитры слева.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="builder-pane builder-canvas" aria-label="Форма">
      <ol className="canvas-list">
        {blocks.map((block) => (
          <li key={block.id}>
            <button
              type="button"
              className={selectedId === block.id ? 'canvas-block selected' : 'canvas-block'}
              aria-pressed={selectedId === block.id}
              onClick={() => select(block.id)}
            >
              <span className="canvas-block-label">{block.label || '(без названия)'}</span>
              <span className="canvas-block-type">{blockTypeLabel(block.type)}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
