import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { DEFAULT_SUBMIT_LABEL, type FormSchema } from '@entities/formSchema'
import { type Answer } from '@fields/answer'
import { BlockField } from '@fields/BlockField'
import { designClasses, designToVars } from '@fields/design'
import {
  blockRowWidths,
  cellVars,
  groupBlocks,
  groupMeta,
  groupRowWidths,
  packGroupRows,
  packRows,
  splitFormTitle,
  splitPages,
  splitThankYou,
} from '@fields/groups'
import { CoverBand, LogoMark, pageClass } from '@fields/pageChrome'
import { SlotStubProvider } from '@fields/booking'
import { MentionContext, mentionResolver } from '@fields/mention'
import { SlotStub } from '@fields/slots/SlotStub'
import { groupClass } from '@fields/space'

// Лист шаблона — та самая страница, которую получит автор, нарисованная теми же
// кирпичами, что превью редактора и публичный рендерер. Не картинка «про форму», а
// форма: разъехаться галерее с продуктом физически нечем, вид едет за `fields.css`
// сам.
//
// ОФОРМЛЕНИЕ НАДЕВАЕТСЯ ЦЕЛИКОМ, а не «пока шаблоны его не носят». Ширина колонки,
// шрифт, тема, палитра, размеры контролов и кнопки живут в `design` документа и
// доезжают до вида ровно двумя вызовами (`designToVars` + `designClasses`) — теми же,
// что у рендерера. Пропусти их — и шаблон с колонкой в 560px показывался бы в галерее
// колонкой в 700, то есть галерея врала бы про единственное, ради чего её смотрят.
// Так же надеты обложка с логотипом (`pageChrome`) и подпись кнопки отправки.
//
// ЧЕГО ЛИСТ НАМЕРЕННО НЕ ДЕЛАЕТ, три вещи:
//
//   • СВОЙ CSS АВТОРА (`design.css`) не применяется. Классы `rf-*` носит и полотно
//     редактора, поэтому `<style>` из формы покрасил бы САМ КАБИНЕТ: `.rf-input
//     {display:none}` погасил бы поля вокруг. Настоящая граница здесь одна — отдельный
//     документ (`PreviewFrame`, так и сделано у превью редактора), и заводить фрейм на
//     каждую плитку галереи мы не станем. Встроенные шаблоны своего CSS не несут
//     (`TemplateItem` его не выражает), так что сегодня это цена без покупки.
//   • УСЛОВНАЯ ЛОГИКА не считается: ветка показывается ОТ ОТВЕТА, а лист — картинка
//     формы, а не её прохождение. Показывается документ как есть — все вопросы
//     первой страницы.
//   • БЕЙДЖ «Сделано в Trillix» не рисуется: он про ТАРИФ смотрящего, а не про шаблон,
//     и знать о нём галерея может только лишним запросом снимка тарифа.
//
// ПРОВАЙДЕРЫ `@fields` НАДЕВАЮТСЯ ОБА, и это не запас на будущее. Пока шаблоны были
// шестью заготовками в коде, ни вопроса записи, ни подстановок `@` в них не бывало
// по построению; теперь шаблон — документ ЖИВОЙ формы, и в нём есть всё, что автор
// поставил на полотно. Без заглушки записи вопрос `slot` нарисовался бы пустотой,
// без резолвера подстановка `@` — именем вопроса вместо ответа.
//
// Резолвер зовётся БЕЗ плана: лист логику не считает (см. выше), и передавать сюда
// половину расчёта значило бы обещать точность, которой у листа нет.
export function TemplateSheet({ schema }: { schema: FormSchema }) {
  const { design, cover, logo } = schema
  // Заголовок формы — блок документа, но рисуется ВНЕ .rf-form: тем же разделителем,
  // что у рендерера, иначе он получил бы ритм «между вопросами» вместо своего.
  const { title, rest } = splitFormTitle(schema.blocks)
  // ПЕРВЫЙ ЭКРАН, а не документ целиком: экран после отправки и вторая страница —
  // не то, что респондент увидит, открыв ссылку. Оба отрезаются теми же помощниками,
  // что у рендерера, поэтому граница страницы у галереи и у формы одна.
  const { blocks } = splitThankYou(rest)
  const firstPage = splitPages(blocks)[0] ?? []
  const groups = groupMeta(firstPage)
  const label = schema.submitLabel?.trim() || DEFAULT_SUBMIT_LABEL
  // КОНТРОЛЫ НЕ `disabled`, И ЭТО НЕСУЩЕЕ. `disabled` — не «то же самое, но нельзя
  // трогать»: `.rf-submit:disabled` гасит кнопку до половинной прозрачности, а
  // `.rf-input:disabled` подставляет полю ПРОЗРАЧНЫЙ фон вместо `--rf-field-bg`
  // (правило из фазы 6.5, когда холст и поле были одним белым, — TD-73). То есть
  // ровно тот вид, который галерея обещает показать, disabled и подменяет.
  //
  // Вместо запрета — ответы в состоянии просмотра: лист заполняется, как заполнил бы
  // его респондент, и никуда не сохраняется (web/CLAUDE.md — это состояние просмотра,
  // а не документа). В плитке до них дело не доходит: её коробка `inert`.
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const mentions = useMemo(() => mentionResolver(schema.blocks, answers), [schema.blocks, answers])

  return (
    <SlotStubProvider value={SlotStub}>
      <MentionContext.Provider value={mentions}>
        {/* Контейнер темы обнимает обложку и страницу разом — как у рендерера и полотна. */}
        <div className={`tpl-sheet rf-theme ${designClasses(design)}`} style={designToVars(design)}>
          <CoverBand cover={cover} />
          <div className={pageClass(cover)}>
            <LogoMark logo={logo} over={Boolean(cover)} />
            {title && <BlockField block={title} />}
            <div className="rf-form">
              {packRows(groupBlocks(firstPage)).map((row) => {
                const renderGroup = (group: (typeof row)[number][number]) => (
                  // Ступень воздуха перед вопросом — по типу его первого блока
                  // (@fields/space), тем же кодом, что у рендерера и полотна.
                  <div key={group.id} className={groupClass(group.blocks)}>
                    {packGroupRows(group.blocks).map((innerRow) => {
                      const render = (block: (typeof innerRow)[number][number]) => (
                        <BlockField
                          key={block.id}
                          block={block}
                          captionText={groups.get(block.groupId)?.caption}
                          captionRequired={groups.get(block.groupId)?.required}
                          value={answers[block.id]}
                          onChange={(value: Answer) =>
                            setAnswers((prev) => ({ ...prev, [block.id]: value }))
                          }
                          disabled={false}
                        />
                      )
                      const innerWidths = blockRowWidths(innerRow)
                      return innerRow.length > 1 ? (
                        <div key={innerRow[0]![0]!.id} className="rf-row">
                          {innerRow.map((cell, i) => (
                            <div
                              key={cell[0]!.id}
                              className="rf-cell"
                              style={cellVars(innerWidths, i)}
                            >
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
                // Обёртка rf-row — только у настоящей пары колонок: одиночный ряд остаётся
                // прямым ребёнком rf-form (лишний div не меняет вид, но шумит в DOM).
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
            {/* Кнопка отправки — часть вида страницы, поэтому лист без неё был бы неполным.
            Ряд и коробка те же, что у респондента: выравнивание кнопки задаётся внутри
            коробки, и без неё настройка «кнопка по центру» до листа не доехала бы.
            Без `disabled` и без обработчика — как у превью редактора: гашение до
            половинной прозрачности показало бы кнопку, которой на форме не бывает. */}
            <div className="rf-nav">
              <div className="rf-nav-main">
                <button type="button" className="rf-submit">
                  {label}
                </button>
              </div>
            </div>
          </div>
        </div>
      </MentionContext.Provider>
    </SlotStubProvider>
  )
}

// РАЗМЕР ВИРТУАЛЬНОГО ЭКРАНА — 1280×720, обычный десктопный вьюпорт (решение
// владельца 2026-09-08: плитка это мини-версия обычного экрана 16:9, и форма на ней
// должна выглядеть как на настоящей странице).
//
// Число не круглое ради круглости: страница формы центрует колонку и оставляет по
// бокам поля, а сверху — 144px воздуха над заголовком. Видно это только на ЭКРАНЕ
// шире колонки; на виртуальных 900 форма разворачивалась бы во всю ширину, то есть
// показывала бы вид, которого на мониторе не бывает. Цена честности — масштаб: при
// плитке в 550px это 0.43, и подписи вопросов читаются формой строки, а не словами.
// За словами есть окно просмотра — тот же лист в натуральную величину.
const SCREEN_WIDTH = 1280
const SCREEN_HEIGHT = Math.round((SCREEN_WIDTH / 16) * 9)

// Миниатюра — тот же лист под `transform: scale`. Масштаб считается ИЗМЕРЕНИЕМ ширины
// коробки, а не подбором по брейкпоинтам: колонка галереи тянется во всю страницу, и
// ширина плитки в ней — величина плавающая, которой в CSS нет имени.
//
// МИНА: медиазапросы внутри листа смотрят на ВЬЮПОРТ БРАУЗЕРА, а не на виртуальный
// экран, — `transform` про них ничего не знает. Мобильные поля страницы (640px в
// fields.css) поэтому включатся в миниатюре, если сузить окно кабинета, а не когда
// сузится плитка. На узком окне галерея и так стоит одной колонкой, поэтому вид
// остаётся правдой; но переносить сюда любое правило «по ширине экрана» бессмысленно.
export function TemplateThumb({ schema }: { schema: FormSchema }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    // Ширина 0 бывает у ещё не разложенной коробки (и всегда — в happy-dom): масштаб
    // тогда остаётся прежним, иначе лист схлопнулся бы в точку.
    const measure = () => {
      const width = node.clientWidth
      if (width > 0) setScale(width / SCREEN_WIDTH)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={box}
      className="tpl-thumb relative overflow-hidden"
      // 16:9 — форма плитки, а не следствие содержимого: ряд плиток разной высоты
      // читается как сбой раскладки, а не как разные шаблоны.
      style={{ aspectRatio: '16 / 9' }}
      // Миниатюра декоративна: рядом стоит название шаблона словами, а поля внутри
      // не заполняются. `inert` убирает их и из порядка обхода табом, и из дерева
      // доступности — иначе одна плитка стоила бы читателю с экранным диктором
      // семи «полей ввода», в которые нельзя писать.
      inert
      aria-hidden="true"
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: SCREEN_WIDTH, height: SCREEN_HEIGHT, transform: `scale(${scale})` }}
      >
        <TemplateSheet schema={schema} />
      </div>
    </div>
  )
}
