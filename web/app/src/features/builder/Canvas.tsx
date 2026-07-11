import { type Block } from '@entities/formSchema'

import { blockTypeLabel } from './blockTypes'
import { useBuilderStore } from './storeContext'

// Канвас — упорядоченный список блоков. label и description правятся инлайн прямо
// здесь; фокус/клик по блоку выделяет его (правая панель показывает required и
// опции). Перемещение блоков — шаг 7, автосейв правок — шаг 6.
export function Canvas() {
  const blocks = useBuilderStore((s) => s.blocks)

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
            <CanvasBlock block={block} />
          </li>
        ))}
      </ol>
    </section>
  )
}

function CanvasBlock({ block }: { block: Block }) {
  const selected = useBuilderStore((s) => s.selectedId === block.id)
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const select = useBuilderStore((s) => s.select)

  return (
    // Выделение по фокусу (клавиатура/клик в поле) и по клику в пустую зону карточки.
    <div
      className={selected ? 'canvas-block selected' : 'canvas-block'}
      onFocusCapture={() => select(block.id)}
      onClick={() => select(block.id)}
    >
      <span className="canvas-block-type">{blockTypeLabel(block.type)}</span>
      <input
        className="canvas-block-label"
        value={block.label}
        placeholder="Вопрос"
        aria-label="Название блока"
        onChange={(e) => updateBlock(block.id, { label: e.target.value })}
      />
      <textarea
        className="canvas-block-desc"
        value={block.description ?? ''}
        placeholder="Описание (необязательно)"
        aria-label="Описание блока"
        rows={2}
        onChange={(e) => updateBlock(block.id, { description: e.target.value })}
      />
    </div>
  )
}
