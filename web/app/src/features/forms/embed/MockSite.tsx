import { useEffect, useRef } from 'react'

import { type EmbedMode } from '../embedSnippet'

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
// Документ собирается один раз: смена настройки перемонтирует фрейм целиком (сниппет
// в зависимостях эффекта, а бейдж — ключом на PreviewArea в EmbedView), как на чужом
// сайте её меняли бы правкой кода и перезагрузкой страницы.

// Скелет страницы: заглушки вместо текста и картинок — шапка с меню, заголовок,
// вводный абзац, форма, большая картинка, ряд карточек и подвал. Своя разметка, а не
// копия чужого лендинга: сцена обязана быть узнаваемо ненастоящей, иначе автор начнёт
// править её, а не форму. Настоящий текст на ней ровно один — «Ваша страница»: он
// называет, чья это страница, и без него сцена читается как часть кабинета.
//
// СТРАНИЦА СЕРАЯ, А НЕ БЕЛАЯ (решение владельца 2026-08-27), и это не только вкус:
// вставка по умолчанию прозрачная, и на белой странице тумблер «Прозрачный фон» не
// менял бы ровно ничего — ни включённый, ни выключенный. Серое полотно делает оба его
// положения видимыми: включён — форма лежит на фоне сайта, выключен — белым
// прямоугольником поверх него. Отсюда же требование к заглушкам: они темнее полотна
// страницы, иначе на сером фоне их нет вовсе.
//
// ЦВЕТА — ЛИТЕРАЛЫ ТОКЕНОВ КАБИНЕТА В oklch, а не «какой-то серый»: макет живёт в
// СВОЁМ документе, наших переменных там нет (взять `var(--muted)` неоткуда), а
// подобранный на глаз холодный серый рядом с тёплой нейтралью кабинета читался
// чужим. Значения повторяют `--muted` (полотно страницы), `--border` и `--foreground`
// из `index.css` — расходятся они только вместе с правкой темы, поэтому сверяться
// стоит именно с теми строками.
const MOCK_STYLES = `
  :root { color-scheme: light }
  body {
    margin: 0;
    background: oklch(0.945 0.006 80);
    color: oklch(0.32 0.012 70);
    font-family: system-ui, sans-serif;
  }
  .wrap { margin: 20px 130px }
  .nav { display: flex; align-items: center; justify-content: space-between; height: 56px }
  .logo { width: 132px; height: 40px; background: oklch(0.895 0.007 80); border-radius: 4px }
  .menu { display: flex; gap: 20px }
  .pill { width: 88px; height: 16px; background: oklch(0.895 0.007 80); border-radius: 4px }
  .title { margin: 20px 0 0; font-size: 34px; line-height: 1.15; letter-spacing: -0.02em }
  .lead { margin-top: 14px; max-width: 720px }
  .line { height: 16px; background: oklch(0.885 0.007 80); border-radius: 4px; margin-top: 10px }
  .line-short { width: 42% }
  .hero { height: 380px; background: oklch(0.895 0.007 80); border-radius: 4px; margin-top: 40px }
  .cards { display: flex; gap: 24px; margin-top: 24px }
  .card { flex: 1; background: oklch(1 0 0); border-radius: 4px; padding: 20px }
  .thumb { height: 180px; background: oklch(0.925 0.006 80); border-radius: 4px }
  .slot { margin: 32px 0 }
  /* Слот «страницы»: полей нет — фрейм всё равно ложится фиксированным слоем. */
  .slot-bare { margin: 0 }
  .foot {
    display: flex;
    gap: 24px;
    margin-top: 40px;
    padding: 32px;
    background: oklch(1 0 0);
    border-radius: 4px;
  }
  .foot-col { flex: 1 }
`

export function MockSite({ snippet, mode }: { snippet: string; mode: EmbedMode }) {
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
    frame.className = 'block h-full w-full border-0'
    host.append(frame)

    // Документ у пустого фрейма есть сразу после вставки в дерево — это тот же
    // about:blank, в который пишет превью формы (PreviewFrame).
    const doc = frame.contentDocument
    if (doc) {
      doc.documentElement.lang = 'ru'
      const style = doc.createElement('style')
      style.textContent = MOCK_STYLES
      doc.head.append(style)

      // У «СТРАНИЦЫ» МАКЕТА НЕТ ВОВСЕ (решение владельца 2026-08-28): этот вид
      // ЗАМЕЩАЕТ содержимое чужой страницы, и рисовать под ним шапку с карточками
      // значит показывать то, чего посетитель не увидит никогда. Заметно это стало
      // из-за прозрачного фона формы (умолчание панели): заглушки просвечивали
      // сквозь неё, и сцена читалась как «форма поверх сайта» — то есть как блок.
      // Полотно при этом остаётся серым, а не белым: на нём видно, что делает
      // тумблер «Прозрачный фон», ради которого цвет и выбирался.
      const slot = box(doc, mode === 'page' ? 'slot-bare' : 'slot')
      if (mode === 'page') {
        doc.body.append(slot)
      } else {
        // ФОРМА СТОИТ СРАЗУ ПОД ВВОДНЫМ АБЗАЦЕМ, а содержимое страницы — под ней, и
        // порядок этот несущий: за видом формы на экран и приходят. Стоило поставить
        // перед ней большую картинку, как форма уехала за сгиб — в правой половине
        // виден был макет без единственного, ради чего он нарисован.
        const wrap = box(doc, 'wrap')
        wrap.append(nav(doc), title(doc), lead(doc), slot, box(doc, 'hero'), cards(doc), foot(doc))
        doc.body.append(wrap)
      }

      insertSnippet(doc, slot, snippet)
    }

    return () => frame.remove()
  }, [snippet, mode])

  return <div ref={hostRef} className="h-full w-full" />
}

function box(doc: Document, className: string): HTMLDivElement {
  const el = doc.createElement('div')
  el.className = className
  return el
}

function nav(doc: Document): HTMLDivElement {
  const bar = box(doc, 'nav')
  const menu = box(doc, 'menu')
  menu.append(box(doc, 'pill'), box(doc, 'pill'), box(doc, 'pill'))
  bar.append(box(doc, 'logo'), menu)
  return bar
}

// Единственный настоящий текст макета — и он же ответ на вопрос «чья это страница».
function title(doc: Document): HTMLHeadingElement {
  const el = doc.createElement('h1')
  el.className = 'title'
  el.textContent = 'Ваша страница'
  return el
}

function lead(doc: Document): HTMLDivElement {
  const el = box(doc, 'lead')
  el.append(box(doc, 'line'), box(doc, 'line line-short'))
  return el
}

function cards(doc: Document): HTMLDivElement {
  const row = box(doc, 'cards')
  for (let i = 0; i < 3; i++) {
    const card = box(doc, 'card')
    card.append(box(doc, 'thumb'), box(doc, 'line'), box(doc, 'line line-short'))
    row.append(card)
  }
  return row
}

function foot(doc: Document): HTMLDivElement {
  const el = box(doc, 'foot')
  for (let i = 0; i < 4; i++) {
    const col = box(doc, 'foot-col')
    col.append(box(doc, 'line'), box(doc, 'line'), box(doc, 'line line-short'))
    el.append(col)
  }
  return el
}

/**
 * insertSnippet — разметка сниппета, ставшая живыми узлами документа макета.
 *
 * РАЗБОР, А НЕ СБОРКА ЗАНОВО: предмет предпросмотра — именно та строка, которую автор
 * скопирует, поэтому она обязана пройти путь «текст → узлы», как на чужом сайте.
 * `DOMParser` этот путь и даёт, ничего при этом не исполняя.
 *
 * Здесь нет нарушения инварианта 4 («пользовательский контент рендерится как текст»):
 * строка не пользовательский контент, а наш собственный вывод `embedCode` —
 * единственное, что в ней от автора, это надпись на кнопке виджета, и она проходит
 * через `escapeAttr`. Проверка эта не на месте использования, поэтому и вынесена в
 * комментарий: испортить её можно только правкой генератора, у которого свои юниты.
 *
 * ДВЕ МИНЫ, обе тихие:
 *
 * 1. `<script>`, попавший в документ разбором, НЕ ИСПОЛНЯЕТСЯ (спецификация помечает
 *    такие узлы «уже начатыми»), поэтому тег пересоздаётся с теми же атрибутами.
 *    Фрейм — что двухтеговой вставки (`data-trillix-src`, его поднимет загрузчик),
 *    что голый из варианта «без скрипта» — переносится как есть.
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
      // ВСПЛЫВАЮЩАЯ ФОРМА В ПРЕДПРОСМОТРЕ ПОКАЗЫВАЕТСЯ ОТКРЫТОЙ: смотреть на кнопку
      // бессмысленно, автор пришёл за видом формы. Открываем НАЖАТИЕМ НА ТУ САМУЮ
      // КНОПКУ, которую построил сниппет, а не своим вызовом `Trillix.open` с
      // собранными заново настройками, — иначе предпросмотр перестал бы быть
      // предпросмотром вставленного кода. Кнопка эта невидима (`previewCode`), так
      // что на сцене её нет — есть только форма.
      //
      // МИНА: открытие уводит фокус на кнопку закрытия внутри макета, а макет
      // пересобирается на каждую правку настройки — автор, меняющий ширину панели,
      // терял бы каретку через полсекунды после каждого символа. Поэтому фокус
      // возвращается туда, где он был в кабинете.
      const trigger = parsed.querySelector('[data-trillix-open]')
      if (trigger) {
        script.addEventListener('load', () => {
          const active = document.activeElement as HTMLElement | null
          doc.querySelector<HTMLButtonElement>('[data-trillix-open]')?.click()
          active?.focus()
        })
      }
      slot.append(script)
      continue
    }
    slot.append(doc.importNode(node, true))
  }
}
