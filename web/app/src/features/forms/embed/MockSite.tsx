import { useEffect, useRef } from 'react'

// МАКЕТ ЧУЖОГО САЙТА — отдельный документ, и это обязательное условие, а не приём
// оформления: виджет ставит кнопку и модалку через `position: fixed`, и в документе
// кабинета они накрыли бы собой весь экран. Свой документ ограничивает их фреймом,
// заодно давая правдивую сцену — страницу, которая ничего не знает о нашем CSS.
//
// ВНУТРЬ ИДЁТ РОВНО ТОТ КОД, КОТОРЫЙ АВТОР КОПИРУЕТ. Разметка сниппета не собирается
// здесь заново: она приходит строкой из того же генератора, что печатает её в блоке
// кода (`embedSnippet.ts`), и разбирается на узлы. Иначе предпросмотр показывал бы
// «примерно то же самое» — и врал бы ровно в тех случаях, ради которых заведён.
// Единственная добавка — `data-preview="1"`: с ним форма не считает визит и не
// отправляет ответ (ARCHITECTURE §10).
//
// Документ собирается один раз: смена настройки перемонтирует фрейм целиком (ключ в
// EmbedView), как на чужом сайте её меняли бы правкой кода и перезагрузкой страницы.

// Скелет страницы: серые области вместо текста и картинок. Своя разметка, а не копия
// чужого лендинга, — сцена обязана быть узнаваемо ненастоящей, иначе автор начнёт
// править её, а не форму.
const MOCK_STYLES = `
  :root { color-scheme: light }
  body { margin: 0; background: #ffffff; font-family: system-ui, sans-serif }
  .wrap { max-width: 880px; margin: 0 auto; padding: 24px 24px 64px }
  .bar { height: 44px; background: #e9eaee; border-radius: 8px }
  .line { height: 14px; background: #eceef2; border-radius: 999px; margin-top: 12px }
  .line-short { width: 42% }
  .cols { display: flex; gap: 16px; margin-top: 24px }
  .box { flex: 1; height: 140px; background: #eceef2; border-radius: 12px }
  .slot { margin: 32px 0 }
  .foot { height: 180px; background: #f1f2f5; border-radius: 12px; margin-top: 32px }
`

export function MockSite({ snippet }: { snippet: string }) {
  const hostRef = useRef<HTMLDivElement>(null)

  // ФРЕЙМ СОЗДАЁТСЯ ЭФФЕКТОМ И УНОСИТСЯ ВМЕСТЕ С НИМ, а не живёт в разметке. Причина
  // — состояние загрузчика: оно лежит в ОКНЕ фрейма (реестр вставок, счётчик кнопок
  // по углам, запертый скролл), а окно переживает и уборку узлов, и `document.open`.
  // В dev StrictMode прогоняет эффект дважды, и с постоянным фреймом второй прогон
  // отдавал бы свой сниппет уже живущему экземпляру загрузчика: в углу вставали две
  // кнопки виджета — ровно та мина, о которой предупреждает EMBED.md §10, только у
  // нас на экране. Новый элемент = новое окно = чистый лист.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const frame = host.ownerDocument.createElement('iframe')
    frame.title = 'Страница сайта с формой'
    frame.className = 'block h-full w-full border-0 bg-white'
    host.append(frame)

    // Документ у пустого фрейма есть сразу после вставки в дерево — это тот же
    // about:blank, в который пишет превью формы (PreviewFrame).
    const doc = frame.contentDocument
    if (doc) {
      doc.documentElement.lang = 'ru'
      const style = doc.createElement('style')
      style.textContent = MOCK_STYLES
      doc.head.append(style)

      const wrap = box(doc, 'wrap')
      const slot = box(doc, 'slot')
      wrap.append(box(doc, 'bar'), box(doc, 'line'), box(doc, 'line line-short'), cols(doc), slot)
      wrap.append(box(doc, 'foot'))
      doc.body.append(wrap)

      insertSnippet(doc, slot, snippet)
    }

    return () => frame.remove()
  }, [snippet])

  return <div ref={hostRef} className="h-full w-full" />
}

function box(doc: Document, className: string): HTMLDivElement {
  const el = doc.createElement('div')
  el.className = className
  return el
}

function cols(doc: Document): HTMLDivElement {
  const row = box(doc, 'cols')
  row.append(box(doc, 'box'), box(doc, 'box'))
  return row
}

/**
 * insertSnippet — разметка сниппета, ставшая живыми узлами документа макета.
 *
 * РАЗБОР, А НЕ СБОРКА ЗАНОВО: предмет предпросмотра — именно та строка, которую автор
 * скопирует, поэтому она обязана пройти путь «текст → узлы», как на чужом сайте.
 * `DOMParser` этот путь и даёт, ничего при этом не исполняя.
 *
 * Здесь нет нарушения инварианта 4 («пользовательский контент рендерится как текст»):
 * строка не пользовательский контент, а наш собственный вывод `scriptSnippet` —
 * единственное, что в ней от автора, это надпись на кнопке виджета, и она проходит
 * через `escapeAttr`. Проверка эта не на месте использования, поэтому и вынесена в
 * комментарий: испортить её можно только правкой генератора, у которого свои юниты.
 *
 * ДВЕ МИНЫ, обе тихие:
 *
 * 1. `<script>`, попавший в документ разбором, НЕ ИСПОЛНЯЕТСЯ (спецификация помечает
 *    такие узлы «уже начатыми»), поэтому тег пересоздаётся с теми же атрибутами.
 *    Голый `<iframe>` из второго варианта вставки переносится как есть.
 * 2. Разбор кладёт ВЕДУЩИЙ `<script>` в `head`, а не в `body` — по правилам разбора
 *    HTML тело начинается с первого узла, который в голове стоять не может. Наш
 *    сниппет со скриптом — ровно этот случай, поэтому обходятся обе половины
 *    документа; смотри только на `body`, и предпросмотр останется пустым.
 */
function insertSnippet(doc: Document, slot: Element, snippet: string) {
  const parsed = new DOMParser().parseFromString(snippet, 'text/html')
  const nodes = [...Array.from(parsed.head.childNodes), ...Array.from(parsed.body.childNodes)]
  for (const node of nodes) {
    if (node.nodeName === 'SCRIPT') {
      const original = node as HTMLScriptElement
      const script = doc.createElement('script')
      for (const attr of Array.from(original.attributes)) {
        script.setAttribute(attr.name, attr.value)
      }
      // ВИДЖЕТ В ПРЕДПРОСМОТРЕ ПОКАЗЫВАЕТСЯ ОТКРЫТЫМ: смотреть на кнопку в углу
      // бессмысленно, автор пришёл за видом формы. Открываем НАЖАТИЕМ НА ТУ САМУЮ
      // КНОПКУ, которую построил сниппет, а не своим вызовом `Trillix.open` с
      // собранными заново настройками, — иначе предпросмотр перестал бы быть
      // предпросмотром вставленного кода.
      //
      // МИНА: открытие уводит фокус на кнопку закрытия внутри макета, а макет
      // пересобирается на каждую правку настройки — автор, набирающий надпись кнопки,
      // терял бы каретку через полсекунды после каждого символа. Поэтому фокус
      // возвращается туда, где он был в кабинете.
      if (script.hasAttribute('data-trillix-widget')) {
        script.addEventListener('load', () => {
          const active = document.activeElement as HTMLElement | null
          doc.querySelector<HTMLButtonElement>('body > button')?.click()
          active?.focus()
        })
      }
      slot.append(script)
      continue
    }
    slot.append(doc.importNode(node, true))
  }
}
