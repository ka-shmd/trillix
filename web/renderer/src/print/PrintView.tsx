import { useEffect } from 'react'

import { type Answer } from '@fields/answer'
import { BlockField } from '@fields/BlockField'
import { customStyleSheet } from '@fields/customCss'
import { designClasses, DESIGN_VAR_NAMES, designToVars } from '@fields/design'
import { KnownFilesProvider } from '@fields/fileUpload'
import {
  blockRowWidths,
  cellVars,
  groupBlocks,
  groupMeta,
  groupRowWidths,
  packGroupRows,
  packRows,
  splitFormTitle,
} from '@fields/groups'
import { LOCALE } from '@fields/locale'
import { MentionContext, mentionResolver } from '@fields/mention'
import { CoverBand, LogoMark, pageClass } from '@fields/pageChrome'
import { groupClass } from '@fields/space'

import { type PrintData } from './data'

// ПЕЧАТНАЯ СТРАНИЦА ОДНОГО ОТВЕТА — четвёртая поверхность формы, и единственная,
// которую человек не заполняет. Собрана из тех же деталей, что публичная форма
// (@fields + fields.css): PDF ответа обязан выглядеть как форма, а не как отчёт о
// ней, и добиться этого можно только общим кодом вида (ADR §10).
//
// Чем она отличается от FormView, и каждое отличие — следствие того, что документ
// уже отправлен:
//   • ОДИН ЛИСТ, а не шаги: page_break на бумаге не значит ничего (страницы режет
//     принтер), и BlockField рисует его пустым сам;
//   • НЕТ КНОПОК — ни отправки, ни «Далее»: нажимать на бумаге нечего;
//   • НЕТ УСЛОВНОЙ ЛОГИКИ: печатаются ВСЕ вопросы версии. Вопрос, скрытый условием
//     у респондента, остаётся на листе пустым — и это честнее, чем лист, из
//     которого молча пропала часть формы;
//   • контролы disabled и заполнены — ровно как в превью билдера, где тот же режим
//     существует с фазы 4 (fields.css: .rf-input:disabled выглядит как активный).
export function PrintView({ data }: { data: PrintData }) {
  const { schema } = data
  const blocks = schema.blocks
  const { title: formTitle, rest } = splitFormTitle(blocks)
  const groups = groupMeta(blocks)
  const answers = data.answers as Record<string, Answer>

  // Оформление надевается на <html> тем же кодом, что у рендерера. Здесь оно не
  // гонка с сервером, а единственный источник: api печатает в документ только
  // данные, оболочку одевает страница. Успеть до печати эффект обязан и успевает —
  // браузер принтера печатает после отрисовки, а не по таймеру.
  useEffect(() => {
    const root = document.documentElement
    const vars = designToVars(schema.design)
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
    const cls = designClasses(schema.design).split(' ').filter(Boolean)
    root.classList.add(...cls)
    return () => {
      for (const name of DESIGN_VAR_NAMES) root.style.removeProperty(name)
      root.classList.remove(...cls)
    }
  }, [schema.design])

  const customCss = customStyleSheet(schema.design?.css)
  const mentions = mentionResolver(blocks, answers)

  return (
    <KnownFilesProvider value={fileMap(data)}>
      <MentionContext.Provider value={mentions}>
        {/* CSS автора — текстовым узлом, как в рендерере (инвариант 4). Своё
          оформление действует и на бумаге: это та же форма. */}
        {customCss ? <style>{customCss}</style> : null}
        <CoverBand cover={schema.cover} />
        <main className={pageClass(schema.cover)}>
          <LogoMark logo={schema.logo} over={Boolean(schema.cover)} />
          {formTitle && <BlockField block={formTitle} />}
          <div className="rf-form">
            {packRows(groupBlocks(rest)).map((row) => {
              const renderGroup = (group: (typeof row)[number][number]) => (
                <div key={group.id} className={groupClass(group.blocks)}>
                  {packGroupRows(group.blocks).map((innerRow) => {
                    const render = (block: (typeof innerRow)[number][number]) => (
                      <BlockField
                        key={block.id}
                        block={block}
                        captionText={groups.get(block.groupId)?.caption}
                        captionRequired={groups.get(block.groupId)?.required}
                        value={answers[block.id]}
                        disabled
                        readOnly
                      />
                    )
                    const innerWidths = blockRowWidths(innerRow)
                    return innerRow.length > 1 ? (
                      <div key={innerRow[0]![0]!.id} className="rf-row">
                        {innerRow.map((cell, i) => (
                          <div key={cell[0]!.id} className="rf-cell" style={cellVars(innerWidths, i)}>
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
              const first = row[0]?.[0]
              if (!first) return null
              const widths = groupRowWidths(row)
              return row.length > 1 ? (
                <div key={first.id} className="rf-row">
                  {row.map((cell, i) => (
                    <div key={cell[0]!.id} className="rf-cell" style={cellVars(widths, i)}>
                      {cell.map(renderGroup)}
                    </div>
                  ))}
                </div>
              ) : (
                renderGroup(first)
              )
            })}
          </div>
          <PrintFooter data={data} />
        </main>
      </MentionContext.Provider>
    </KnownFilesProvider>
  )
}

// fileMap — карта файлов в том виде, в каком её ждёт контрол поля (id → имя+размер).
// Ключ дублируется полем id: контрол получает файл целиком, а не пару из карты.
function fileMap(data: PrintData) {
  const out: Record<string, { id: string; name: string; size: number }> = {}
  for (const [id, f] of Object.entries(data.files)) out[id] = { id, ...f }
  return out
}

// Подвал листа: когда ответ пришёл и под каким id он лежит в кабинете. Это
// единственное, чего нет в самой форме, и единственное, ради чего лист вообще
// отличается от неё, — по нему найдут запись, когда PDF окажется в чужой папке
// через год.
function PrintFooter({ data }: { data: PrintData }) {
  return (
    <footer className="print-footer">
      <span>Отправлен {formatMoscow(data.submittedAt)}</span>
      <span className="print-footer-id">ID ответа: {data.submissionId}</span>
    </footer>
  )
}

// Время печатается по Москве и подписано зоной: PDF уезжает по почте и открывается
// где угодно, а «14:05» без зоны в документе, который переживёт переписку, — это не
// время, а повод спорить. Зона фиксированная, а не браузерная: браузер здесь —
// серверный принтер в UTC, и его локаль к делу отношения не имеет.
function formatMoscow(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const text = new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'Europe/Moscow',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at)
  return `${text} МСК`
}
