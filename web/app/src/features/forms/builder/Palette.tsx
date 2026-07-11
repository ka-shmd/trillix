import { MAX_BLOCKS } from '@entities/formSchema'

import { BLOCK_TYPES } from './blockTypes'
import { useBuilderStore } from './storeContext'

// Палитра типов: клик добавляет блок соответствующего типа в конец канваса и
// выделяет его. На пределе (MAX_BLOCKS) кнопки дизейблятся — сервер всё равно
// отверг бы 201-й блок, но честнее не дать его добавить.
export function Palette() {
  const addBlock = useBuilderStore((s) => s.addBlock)
  const full = useBuilderStore((s) => s.blocks.length >= MAX_BLOCKS)

  return (
    <aside className="builder-pane builder-palette" aria-label="Типы блоков">
      <h2 className="builder-pane-title">Добавить блок</h2>
      <div className="palette-list">
        {BLOCK_TYPES.map(({ type, label }) => (
          <button
            key={type}
            type="button"
            className="palette-btn"
            onClick={() => addBlock(type)}
            disabled={full}
          >
            {label}
          </button>
        ))}
      </div>
      {full && <p className="builder-hint">Достигнут предел в {MAX_BLOCKS} блоков.</p>}
    </aside>
  )
}
