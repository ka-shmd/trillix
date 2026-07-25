import { DEFAULT_SUBMIT_LABEL } from '@entities/formSchema'
import { BlockField } from '@fields/BlockField'
import { groupBlocks, groupMeta, packRows } from '@fields/groups'

import { useBuilderStore } from './storeContext'

// Превью — форма как её увидит респондент: заголовок, поля стора и кнопка отправки.
// Тот же вид (rf-*), что и у рендерера и у редактора — WYSIWYG. Заголовок приходит
// пропом (forms.title сохраняется отдельно от схемы), кнопка/блоки — из стора.
export function PreviewPane({ title }: { title: string }) {
  const blocks = useBuilderStore((s) => s.blocks)
  const submitLabel = useBuilderStore((s) => s.submitLabel)
  const label = submitLabel.trim() || DEFAULT_SUBMIT_LABEL
  const groups = groupMeta(blocks)
  // Ряды вопросов (спека §5): вопрос с column='right' встаёт рядом с предыдущим,
  // ряд из одного — во всю ширину. Тот же раскладчик, что у рендерера и полотна.
  const rows = packRows(groupBlocks(blocks))

  return (
    <div className="rf-page">
      <h1 className="rf-title">{title.trim() || 'Форма'}</h1>
      {blocks.length === 0 ? (
        <p className="rf-empty">Пока нечего показать — добавьте блоки в редакторе.</p>
      ) : (
        <div className="rf-form">
          {rows.map((row) => {
            const groupNodes = row.map((group) => (
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
            ))
            // Обёртка rf-row — только у настоящей пары: одиночный ряд остаётся
            // прямым ребёнком rf-form (лишний div не меняет вид, но шумит в DOM).
            const first = row[0]
            if (!first) return null
            return row.length > 1 ? (
              <div key={first.id} className="rf-row">
                {groupNodes}
              </div>
            ) : (
              groupNodes[0]
            )
          })}
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
