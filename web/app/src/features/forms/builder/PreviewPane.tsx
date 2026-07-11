import { BlockField } from '@fields/BlockField'

import { useBuilderStore } from './storeContext'

// Превью — блоки стора, отрисованные как форма для респондента. Читает тот же
// стор, что и редактор, поэтому всегда показывает актуальный черновик.
export function PreviewPane() {
  const blocks = useBuilderStore((s) => s.blocks)

  if (blocks.length === 0) {
    return (
      <div className="canvas-empty">
        <p>Пока нечего показать — добавьте блоки в редакторе.</p>
      </div>
    )
  }

  return (
    <div className="rf-form">
      {blocks.map((block) => (
        <BlockField key={block.id} block={block} />
      ))}
    </div>
  )
}
