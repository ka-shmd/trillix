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
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const doc = frameRef.current?.contentDocument
    if (!doc) return

    doc.documentElement.lang = 'ru'
    const style = doc.createElement('style')
    style.textContent = MOCK_STYLES
    doc.head.appendChild(style)

    const wrap = box(doc, 'wrap')
    wrap.append(
      box(doc, 'bar'),
      box(doc, 'line'),
      box(doc, 'line line-short'),
      cols(doc),
      box(doc, 'slot'),
    )
    const slot = wrap.lastElementChild!
    wrap.append(box(doc, 'foot'))
    doc.body.append(wrap)

    insertSnippet(doc, slot, snippet)
  }, [snippet])

  return (
    <iframe
      ref={frameRef}
      title="Страница сайта с формой"
      className="block h-full w-full border-0 bg-white"
    />
  )
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
 * МИНА: `<script>`, попавший в документ разбором, НЕ ИСПОЛНЯЕТСЯ (спецификация
 * помечает такие узлы «уже начатыми»), поэтому тег пересоздаётся с теми же
 * атрибутами. Голый `<iframe>` из второго варианта вставки переносится как есть.
 */
function insertSnippet(doc: Document, slot: Element, snippet: string) {
  const parsed = new DOMParser().parseFromString(snippet, 'text/html')
  for (const node of Array.from(parsed.body.childNodes)) {
    if (node.nodeName === 'SCRIPT') {
      const original = node as HTMLScriptElement
      const script = doc.createElement('script')
      for (const attr of Array.from(original.attributes)) {
        script.setAttribute(attr.name, attr.value)
      }
      slot.append(script)
      continue
    }
    slot.append(doc.importNode(node, true))
  }
}
