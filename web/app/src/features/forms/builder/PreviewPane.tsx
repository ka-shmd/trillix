import { DEFAULT_SUBMIT_LABEL } from '@entities/formSchema'
import { BlockField } from '@fields/BlockField'
import { groupBlocks, groupMeta, packGroupRows, packRows, splitFormTitle } from '@fields/groups'

import { useBuilderStore } from './storeContext'

// Превью — форма как её увидит респондент: заголовок, поля стора и кнопка отправки.
// Тот же вид (rf-*), что и у рендерера и у редактора — WYSIWYG. Заголовок приходит
// пропом (forms.title сохраняется отдельно от схемы), кнопка/блоки — из стора.
export function PreviewPane({ title }: { title: string }) {
  const allBlocks = useBuilderStore((s) => s.blocks)
  const submitLabel = useBuilderStore((s) => s.submitLabel)
  const label = submitLabel.trim() || DEFAULT_SUBMIT_LABEL
  // Заголовок формы — блок документа (фаза 15), рисуется вне потока вопросов, тем же
  // разделителем, что у рендерера. Проп title остаётся фолбэком: форму, которую
  // автор ещё не открывал после фазы, сервер синтезирует при чтении черновика, но
  // до первого автосейва блока в сторе может не быть.
  const { title: formTitle, rest: blocks } = splitFormTitle(allBlocks)
  const groups = groupMeta(blocks)
  // Ряды вопросов (спека §5): вопрос с column='right' встаёт рядом с предыдущим,
  // ряд из одного — во всю ширину. Тот же раскладчик, что у рендерера и полотна.
  const rows = packRows(groupBlocks(blocks))

  return (
    <div className="rf-page">
      {formTitle ? (
        <BlockField block={formTitle} />
      ) : (
        title.trim() && <h1 className="rf-title">{title.trim()}</h1>
      )}
      {blocks.length === 0 ? (
        <p className="rf-empty">Пока нечего показать — добавьте блоки в редакторе.</p>
      ) : (
        <div className="rf-form">
          {rows.map((row) => {
            const renderGroup = (group: (typeof row)[number][number]) => (
              <div key={group.id} className="rf-group">
                {/* Второй уровень рядов (фаза 15, §6.4): подпись и поле встают бок о
                    бок той же обёрткой .rf-row. Ряд из одного остаётся прямым
                    ребёнком .rf-group — лишний div не меняет вид, но шумит в DOM. */}
                {packGroupRows(group.blocks).map((innerRow) => {
                  const render = (block: (typeof innerRow)[number][number]) => (
                    <BlockField
                      key={block.id}
                      block={block}
                      captionText={groups.get(block.groupId)?.caption}
                      captionRequired={groups.get(block.groupId)?.required}
                    />
                  )
                  return innerRow.length > 1 ? (
                    <div key={innerRow[0]![0]!.id} className="rf-row">
                      {innerRow.map((cell) => (
                        <div key={cell[0]!.id} className="rf-cell">
                          {cell.map(render)}
                        </div>
                      ))}
                    </div>
                  ) : (
                    render(innerRow[0]![0]!)
                  )
                })}
              </div>
            )
            // Обёртка rf-row — только у настоящей пары колонок: одиночный ряд остаётся
            // прямым ребёнком rf-form (лишний div не меняет вид, но шумит в DOM).
            // В колонке может стоять СТОПКА групп (§5): правая колонка ряда с длинным
            // блоком слева. Слева стопки не бывает — там всегда тот, кто открыл ряд.
            const first = row[0]?.[0]
            if (!first) return null
            return row.length > 1 ? (
              <div key={first.id} className="rf-row">
                {row.map((cell) => (
                  <div key={cell[0]!.id} className="rf-cell">
                    {cell.map(renderGroup)}
                  </div>
                ))}
              </div>
            ) : (
              renderGroup(first)
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
