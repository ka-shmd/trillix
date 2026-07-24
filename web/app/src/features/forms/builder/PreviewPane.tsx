import { DEFAULT_SUBMIT_LABEL } from '@entities/formSchema'
import { BlockField } from '@fields/BlockField'
import { groupBlocks, groupMeta } from '@fields/groups'

import { useBuilderStore } from './storeContext'

// Превью — форма как её увидит респондент: заголовок, поля стора и кнопка отправки.
// Тот же вид (rf-*), что и у рендерера и у редактора — WYSIWYG. Заголовок приходит
// пропом (forms.title сохраняется отдельно от схемы), кнопка/блоки — из стора.
export function PreviewPane({ title }: { title: string }) {
  const blocks = useBuilderStore((s) => s.blocks)
  const submitLabel = useBuilderStore((s) => s.submitLabel)
  const label = submitLabel.trim() || DEFAULT_SUBMIT_LABEL
  const groups = groupMeta(blocks)
  const grouped = groupBlocks(blocks)

  return (
    <div className="rf-page">
      <h1 className="rf-title">{title.trim() || 'Форма'}</h1>
      {blocks.length === 0 ? (
        <p className="rf-empty">Пока нечего показать — добавьте блоки в редакторе.</p>
      ) : (
        <div className="rf-form">
          {grouped.map((group) => (
            <div key={group.id} className="rf-group">
              {group.blocks.map((block) => (
                <BlockField
                  key={block.id}
                  block={block}
                  captionText={groups.get(block.groupId)?.caption}
                  captionRequired={groups.get(block.groupId)?.required}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      {/* Не disabled: превью показывает кнопку как у респондента (активной);
          обработчика нет, поэтому клик всё равно ничего не делает. */}
      <button type="button" className="rf-submit">
        {label}
      </button>
    </div>
  )
}
