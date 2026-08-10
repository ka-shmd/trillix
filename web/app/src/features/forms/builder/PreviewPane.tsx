import { useState } from 'react'

import { DEFAULT_SUBMIT_LABEL } from '@entities/formSchema'
import { type Answer } from '@fields/answer'
import { BlockField } from '@fields/BlockField'
import { groupBlocks, groupMeta, packGroupRows, packRows, splitFormTitle } from '@fields/groups'
import { planForm, withVisibleOptions } from '@fields/logic'
import { Badge } from '@fields/Badge'
import { designClasses, designToVars, showFormBadge } from '@fields/design'
import { CoverBand, LogoMark, pageClass } from '@fields/pageChrome'
import { StepBar } from '@fields/stepBar'

import { useFeatureAllowed } from '../../plan/useFeature'

import { useBuilderStore } from './storeContext'

// Превью — форма как её увидит респондент: заголовок, поля стора и кнопка отправки.
// Тот же вид (rf-*), что и у рендерера и у редактора — WYSIWYG. Заголовок приходит
// пропом (forms.title сохраняется отдельно от схемы), кнопка/блоки — из стора.
export function PreviewPane({ title }: { title: string }) {
  const allBlocks = useBuilderStore((s) => s.blocks)
  const submitLabel = useBuilderStore((s) => s.submitLabel)
  const cover = useBuilderStore((s) => s.cover)
  const logo = useBuilderStore((s) => s.logo)
  const design = useBuilderStore((s) => s.design)
  // Бейдж площадки — часть того, что увидит респондент, значит часть превью. Правило
  // общее с сервером (showFormBadge): намерение автора плюс разрешение тарифа. Первая
  // редакция слайса 6 нарисовала бейдж только у респондента, и превью — единственное
  // место, где автор смотрит на форму его глазами, — про бейдж молчало.
  const badge = showFormBadge(design, useFeatureAllowed('form_branding'))
  const label = submitLabel.trim() || DEFAULT_SUBMIT_LABEL
  // Заголовок формы — блок документа (фаза 15), рисуется вне потока вопросов, тем же
  // разделителем, что у рендерера. Проп title остаётся фолбэком: форму, которую
  // автор ещё не открывал после фазы, сервер синтезирует при чтении черновика, но
  // до первого автосейва блока в сторе может не быть.
  const { title: formTitle, rest: blocks } = splitFormTitle(allBlocks)
  // ПРЕВЬЮ ЗАПОЛНЯЕМОЕ (фаза 21). До условной логики поля были декоративны — смотреть
  // не на что, кроме вида. С логикой это перестало работать: ветка показывается ОТ
  // ОТВЕТА, и превью без ответов молча прятало бы от автора всё, что он только что
  // настроил. Ответы живут здесь и никуда не сохраняются: это состояние просмотра, а не
  // документа (web/CLAUDE.md), и уходят вместе с закрытой панелью.
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  // Страницы и видимость — тем же planForm, что считает форму респонденту. Превью,
  // рисующее все страницы подряд или все вопросы разом, соврало бы автору о главном:
  // он не увидел бы ни границ шагов, ни собственного ветвления.
  const plan = planForm(blocks, answers)
  // Звёздочка обязательности — из плана: условно обязательное поле получает её ровно
  // тогда, когда условие сработало (фаза 21).
  const groups = groupMeta(blocks, plan.required)
  const pages = plan.pages
  const lastPage = pages.length - 1
  // Номер страницы держится ЗДЕСЬ, а не в сторе билдера: это состояние просмотра, а не
  // документа (web/CLAUDE.md — «переживает ли перезагрузку?» нет, «нужен ли больше чем
  // одному дереву?» нет). Автор стёр разрыв, стоя на последней странице, — clamp ниже
  // возвращает его в существующий диапазон, а не показывает пустоту.
  const [rawPage, setPage] = useState(0)
  const page = Math.min(rawPage, lastPage)
  // Хром (обложка, логотип, заголовок) — только на первой странице, как у респондента
  // (решение владельца 2026-08-05). Расхождение здесь и означало бы, что превью врёт.
  const chrome = page === 0
  // Ряды вопросов (спека §5): вопрос с column='right' встаёт рядом с предыдущим,
  // ряд из одного — во всю ширину. Тот же раскладчик, что у рендерера и полотна.
  const rows = packRows(groupBlocks(pages[page] ?? []))
  // Есть ли в форме условия вообще — от этого зависит, чем объяснять пустой экран.
  const hasRules = blocks.some(
    (b) =>
      b.visibleIf ||
      b.requiredIf ||
      b.jumpIf?.length ||
      b.settings?.options?.some((o) => o.visibleIf),
  )
  const onChange = (blockId: string, value: Answer) =>
    setAnswers((prev) => ({ ...prev, [blockId]: value }))

  return (
    // Тот же хром, что у рендерера, и теми же двумя компонентами: обложка снаружи
    // страницы, логотип внутри. WYSIWYG держится на общем выводе, а не на похожей
    // вёрстке в двух местах.
    // Контейнер темы обнимает обложку и страницу разом — как на полотне.
    <div className={`rf-theme ${designClasses(design)}`} style={designToVars(design)}>
      <CoverBand cover={chrome ? cover : undefined} />
      <div className={pageClass(chrome ? cover : undefined)}>
        {chrome && <LogoMark logo={logo} over={Boolean(cover)} />}
        {chrome &&
          (formTitle ? (
            <BlockField block={formTitle} />
          ) : (
            title.trim() && <h1 className="rf-title">{title.trim()}</h1>
          ))}
        {/* «Скрыто условиями» говорим только когда условия в форме ЕСТЬ. Пустой план
            бывает и без логики — например у документа из одного разрыва страницы (он
            инертен, ни одной страницы не открывает), и там правильный текст — второй:
            добавьте блоки. Найдено ревью ветки фазы. */}
        {plan.pages.every((p) => p.length === 0) && hasRules ? (
          <p className="rf-empty">
            Все вопросы скрыты условиями — ответьте выше или снимите условие в настройках блока.
          </p>
        ) : plan.pages.every((p) => p.length === 0) ? (
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
                        block={withVisibleOptions(block, plan)}
                        captionText={groups.get(block.groupId)?.caption}
                        captionRequired={groups.get(block.groupId)?.required}
                        value={answers[block.id]}
                        onChange={(value: Answer) => onChange(block.id, value)}
                        // disabled=true — умолчание BlockField (превью было
                        // декоративным). С фазы 21 превью заполняется: иначе автор не
                        // увидит ни одной своей ветки — она показывается ОТ ОТВЕТА.
                        disabled={false}
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
        {/* Кнопки шага — рабочие: превью для того и нужно, чтобы автор прошёл форму
          так же, как её пройдёт респондент. Кнопка отправки по-прежнему без
          обработчика (клик ничего не делает), но выглядит как у респондента —
          активной, и только на последней странице. */}
        <div className="rf-nav">
          {page > 0 && (
            <button type="button" className="rf-back" onClick={() => setPage(page - 1)}>
              Назад
            </button>
          )}
          {page < lastPage ? (
            <button
              type="button"
              className="rf-submit rf-next"
              onClick={() => setPage(page + 1)}
            >
              Далее
            </button>
          ) : (
            <button type="button" className="rf-submit">
              {label}
            </button>
          )}
        </div>
        {/* Линии шагов — тот же компонент и то же место, что у респондента: и вид, и
            правило «кликом только назад» — часть WYSIWYG. */}
        <StepBar pages={pages.length} page={page} onGo={setPage} />
        {badge && <Badge />}
      </div>
    </div>
  )
}
