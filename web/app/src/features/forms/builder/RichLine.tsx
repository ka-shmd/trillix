// Текстовая поверхность строки полотна (фаза 14, этап 14.3): contenteditable вместо
// <textarea>. Всё, что было построено фазой 13 вокруг строки — клавиатурный поток,
// фокус-движок, инлайн-слеш, — не переписывалось: поток говорит с поверхностью через
// адаптер каретки (`caret.ts`), а слеш — через `text()` того же адаптера.
//
// Три решения, каждое куплено дефектом (§3.2 `docs/design/rich-text.md`):
//   1. Поверхность НЕуправляемая. React владеет узлом, но не его детьми: управляемый
//      contenteditable перерисовывался бы на каждый символ и ронял каретку, а полотно
//      и без того ре-рендерится целиком на каждый набранный символ (TD-32).
//   2. Ресинк из стора — только на ВНЕШНЮЮ правку (undo/redo, смена типа, ремаунт),
//      и распознаётся сравнением по значению: свежий массив с тем же содержимым
//      правкой не является. Иначе набор символа стирал бы разметку строки.
//   3. Между compositionstart и compositionend поверхность не трогаем вовсе — ресинк
//      посреди составного ввода рвёт набор (IME, диакритика).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react'
import { toast } from 'sonner'
import { MAX_SPANS, type Mark, type Span, plainText, sameRichText } from '@entities/formSchema'
import { chords, markChord } from './shortcuts'
import {
  activeStyle,
  applyDefaultMarks,
  cutRange,
  insertMention,
  insertText,
  setBg,
  setColor,
  setHref,
  spansFromDom,
  spansToDom,
  toggleMark,
} from './richText'
import { MentionMenu, type MentionItem } from './MentionMenu'
import { richCaret, selectionRange, selectionRect, setCaret, setSelection } from './richCaret'
import type { UpdateKind } from './store'
import { FormatBar } from './FormatBar'
import { lockScroll } from './scrollLock'
import './richLine.css'

// Снимок выделения, над которым висит панель форматирования.
interface Sel {
  from: number
  to: number
  rect: DOMRect
  active: ReadonlySet<Mark>
  href?: string
}

// Сравнение снимков по значению. `rect` сравнивается по четырём числам: DOMRect каждый
// раз новый объект, но координаты у неподвижного выделения те же.
const sameSel = (a: Sel | null, b: Sel): boolean =>
  a !== null &&
  a.from === b.from &&
  a.to === b.to &&
  a.href === b.href &&
  a.active.size === b.active.size &&
  [...b.active].every((m) => a.active.has(m)) &&
  a.rect.x === b.rect.x &&
  a.rect.y === b.rect.y &&
  a.rect.width === b.rect.width &&
  a.rect.height === b.rect.height

export interface RichLineProps {
  // Богатый текст блока из стора — источник правды между правками.
  value: Span[]
  placeholder?: string
  // Доступное имя строки — отдельно от видимой подсказки и НЕ равно ей: у контентной
  // строки подсказка появляется только под фокусом (иначе полотно пестрит серым), а
  // имя, которое то есть, то нет, для скринридера равно отсутствию имени. Пока строка
  // была <textarea>, имя давал `placeholder` — contenteditable такой любезности не
  // делает, и до этой строки у поверхности не было имени вовсе.
  label?: string
  className?: string
  // Каретка приходит в координатах ПЛОСКОГО текста — ровно то, что раньше давал
  // selectionStart у textarea, поэтому инлайн-слеш в BlockRow не переписывается.
  //
  // `kind` отличает команду форматирования от набора. Плоский текст она не меняет, но
  // в историю обязана лечь своим шагом: иначе Ctrl+Z после покраски сносит и её, и всю
  // подпись, набранную до неё, — правки одного блока подряд коалесцируются.
  onChange: (value: Span[], caret: number, kind?: UpdateKind) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  onFocus: () => void
  onBlur: (e: FocusEvent<HTMLElement>) => void
  elRef: (el: HTMLDivElement | null) => void
  // Марки, которыми набирается текст в ПУСТОЙ строке: у заголовков и подписей это `b`
  // (жирность там лежит в документе, а не в весе поверхности — см. .rf-b в fields.css).
  // Пусто/не передано — строка набирается без оформления, как абзац.
  defaultMarks?: readonly Mark[]
  // mentionSources — что можно подставить в эту строку по «@» (docs/design/mentions.md).
  // Не передано — подстановка в строке не работает вовсе: так живут заголовок формы (он
  // стоит первой строкой документа, вопросов выше него не бывает) и все поверхности,
  // которым подстановка не положена.
  //
  // ФУНКЦИЯ, А НЕ ГОТОВЫЙ СПИСОК: имена источников считаются проходом по документу, и
  // делать это на каждый рендер каждой строки — ровно тот механизм, которым фаза 21
  // дважды роняла перф полотна. Список берётся в момент, когда он нужен: меню открылось.
  mentionSources?: () => readonly MentionItem[]
  // mentionLive — id источников, которые ещё разрешаются: по ним чипы делятся на живые
  // и мёртвые. Считает его ВЫЗЫВАЮЩИЙ и только пока в строке есть хоть один чип —
  // подписка на документ его дело, а не строки.
  mentionLive?: ReadonlySet<string>
  // readOnly — поверхность показывает текст, но не принимает ни набора, ни фокуса.
  // Нужна бланку письма на бесплатном тарифе: автор читает своё письмо обычным текстом,
  // а не бледной заглушкой (решение владельца 2026-08-30).
  readOnly?: boolean
  // enterBreaksLine — плоский Enter переносит строку, как Shift+Enter. Полотну не нужен:
  // там Enter создаёт СТРОКУ ДОКУМЕНТА, и перенос стоит на Shift. В бланке письма строк
  // документа нет, а перенос — обычный жест набора текста.
  enterBreaksLine?: boolean
}

// Пустой список — СТАБИЛЬНАЯ ссылка: свежий массив на каждый рендер означал бы лишний
// ре-рендер меню на каждый набранный символ.
const NO_ITEMS: readonly MentionItem[] = []

// Голый Enter — без модификаторов. Аккорды с Enter заняты (chords.enter, lineBreak,
// Mod+Enter), и перенос обязан отличать себя от каждого из них.
const plainEnter = (e: KeyboardEvent<HTMLElement>): boolean =>
  e.code === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
const NO_MARKS: readonly Mark[] = []

export function RichLine({
  value,
  placeholder,
  label,
  className,
  onChange,
  onKeyDown,
  onFocus,
  onBlur,
  elRef,
  defaultMarks = NO_MARKS,
  mentionSources,
  mentionLive,
  readOnly = false,
  enterBreaksLine = false,
}: RichLineProps) {
  const ref = useRef<HTMLDivElement>(null)
  // last — что мы сами в последний раз отдали наружу. Отличие пришедшего value от него
  // (ПО ЗНАЧЕНИЮ) и означает «правку сделали снаружи».
  const last = useRef<Span[]>(value)
  const composing = useRef(false)
  // Выделение, над которым висит панель форматирования. Держится в СОСТОЯНИИ, а не
  // читается из живого Selection в момент нажатия: поле адреса ссылки берёт фокус, и
  // живое выделение к тому моменту уже схлопнуто.
  // Всё про выделение считается ОДИН раз, в момент его изменения, и живёт в состоянии:
  // читать `ref.current` во время рендера нельзя (правило React), да и незачем — панели
  // нужен снимок, а не живой DOM.
  const [sel, setSel] = useState<Sel | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  // Диапазон, которому меняли цвет текста или фона. Пока выделение
  // стоит ровно на нём, подложка выделения погашена (`data-painted`, richLine.css):
  // браузерная заливка перекрывает цвет, и автор перебирал бы образцы вслепую.
  const [painted, setPainted] = useState<{ from: number; to: number } | null>(null)
  // Инлайн-«@» (mentions.md §7) — та же машинерия, что у слеш-меню в BlockRow: `at`
  // это null (закрыто) либо {start, query}, где start — индекс «@» в ПЛОСКОМ тексте, а
  // query — набранное после него до каретки. Живёт здесь, а не в строке полотна,
  // потому что вставка чипа — операция над текстом: ей нужны модель, каретка и DOM,
  // которыми владеет эта поверхность (слеш-меню, наоборот, меняет ТИП блока — операция
  // строки).
  const [at, setAt] = useState<{ start: number; query: string } | null>(null)
  const [atIndex, setAtIndex] = useState(0)
  const menuOpen = at !== null
  // Список источников берётся ТОЛЬКО пока меню открыто: собрать его стоит прохода по
  // документу ради каждого имени, и делать это на каждую правку ради чипа, который и
  // так знает своё имя, незачем.
  const items: readonly MentionItem[] = useMemo(() => {
    if (!menuOpen || !mentionSources) return NO_ITEMS
    const q = (at?.query ?? '').trim().toLowerCase()
    return mentionSources().filter((it) => q === '' || it.label.toLowerCase().includes(q))
  }, [menuOpen, at?.query, mentionSources])

  // Выделение отслеживается на документе: внутри contenteditable его меняют и мышь, и
  // клавиатура, и события у них разные — один `selectionchange` покрывает оба.
  //
  // Модель здесь НЕ собирается. Это место работает на каждом кадре протяжки мышью, а
  // панели нужны два ответа — какие марки стоят на всём выделении и один ли на нём
  // адрес; `activeStyle` читает их прямо с поверхности одним обходом. Сборка спанов
  // ради этого означала бы канон, N новых объектов и пять проходов по массиву — всё
  // немедленно выброшенное.
  const syncSelection = useCallback(() => {
    const el = ref.current
    if (!el || el.ownerDocument.activeElement !== el) return
    const range = selectionRange(el)
    const rect = selectionRect(el)
    if (!range || !rect) {
      setSel(null)
      setLinkOpen(false)
      return
    }
    // Другой диапазон — другая работа: подложка возвращается. Сбрасывает только НЕПУСТОЕ
    // другое выделение — ни схлопывание, ни закрытие панели: команда форматирования
    // перепечатывает строку, выделение на миг схлопывается, и подложка вернулась бы поверх
    // только что выбранного цвета; то же при клике мимо поповера, который восстанавливает
    // то же выделение.
    setPainted((p) => (p && (p.from !== range.from || p.to !== range.to) ? null : p))
    const style = activeStyle(el, range.from, range.to)
    const next = {
      ...range,
      rect,
      active: style.marks,
      href: style.href,
    }
    // Тот же снимок — тот же объект. Это не микрооптимизация: выборщик цвета зовёт
    // команду форматирования на каждом кадре перетаскивания, а диапазон и марки при
    // этом не меняются вовсе. Свежий объект каждый раз означал бы ре-рендер панели,
    // пересчёт позиции поповера и перезапуск обоих эффектов ниже — 60 раз в секунду
    // ради снимка, который не изменился.
    setSel((prev) => (sameSel(prev, next) ? prev : next))
  }, [])

  // Обоим эффектам ниже важен только факт «панель открыта», а не сам снимок: без этого
  // они снимали бы и вешали слушателей на каждое изменение выделения.
  const panelOpen = sel !== null

  // Пока панель открыта, прокрутка заперта: панель стоит по координатам выделения,
  // снятым один раз, и прокрутка увезла бы текст из-под неё (решение владельца
  // 2026-07-27; альтернатива — пересчитывать позицию на каждом кадре).
  useEffect(() => {
    const el = ref.current
    if (!panelOpen || !el) return
    return lockScroll(el)
  }, [panelOpen])

  // Клик мимо строки и мимо панели закрывает панель. Отдельный слушатель нужен потому,
  // что blur самой строки этот случай не покрывает: когда открыто поле адреса, фокус уже
  // не в строке, а в поле, и её blur давно прошёл. Без этого меню ссылки оставалось
  // висеть после клика в пустоту (найдено владельцем в браузере).
  useEffect(() => {
    if (!panelOpen) return
    const doc = ref.current?.ownerDocument
    if (!doc) return
    const onDown = (e: Event) => {
      const t = e.target
      if (!(t instanceof Node)) return
      if (ref.current?.contains(t)) return
      if (t instanceof Element && t.closest('[data-format-bar]')) return
      setSel(null)
      setLinkOpen(false)
    }
    doc.addEventListener('mousedown', onDown)
    return () => doc.removeEventListener('mousedown', onDown)
  }, [panelOpen])

  // Выделение меняют и мышь, и клавиатура, и события у них разные — один
  // `selectionchange` на документе покрывает оба.
  useEffect(() => {
    const doc = ref.current?.ownerDocument
    if (!doc) return
    // Обёртка, а не сама функция: слушателю браузер передаёт событие, а первый аргумент
    // `syncSelection` — это спаны.
    const onChangeSel = () => syncSelection()
    doc.addEventListener('selectionchange', onChangeSel)
    return () => doc.removeEventListener('selectionchange', onChangeSel)
  }, [syncSelection])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (sameRichText(value, last.current) && el.textContent === plainText(value)) return
    const hadFocus = el.ownerDocument.activeElement === el
    const at = hadFocus ? richCaret(el).text().caret : 0
    last.current = value
    spansToDom(el, value)
    if (hadFocus) setCaret(el, Math.min(at, plainText(value).length))
  }, [value])

  // Мёртвый чип — тот, чей источник удалён или уехал НИЖЕ этой строки: подстановки у
  // респондента не будет (§4 спеки). Признак ставится атрибутом прямо в DOM, а не
  // перепечаткой поверхности: перепечатка роняет каретку, а измениться тут может только
  // вид. В модели ему места нет — он вычисляется от документа, а документ и так рядом.
  //
  // СТОИТ ПОСЛЕ ресинка намеренно: тот перепечатывает поверхность целиком, и пометки,
  // расставленные до него, исчезли бы вместе со старыми узлами. Эффекты идут в порядке
  // объявления, и этот порядок здесь — часть работы, а не оформление.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    for (const chip of el.querySelectorAll<HTMLElement>('[data-ref]')) {
      if (mentionLive?.has(chip.dataset.ref ?? '')) delete chip.dataset.dead
      else chip.dataset.dead = ''
    }
  }, [mentionLive, value])

  // commit — единственный путь наружу: сериализуем поверхность в модель и отдаём её
  // вместе с позицией каретки.
  function commit(): void {
    const el = ref.current
    if (!el) return
    const spans = spansFromDom(el)
    // ПУСТАЯ СТРОКА ОБЯЗАНА БЫТЬ ПУСТЫМ УЗЛОМ. Подсказку рисует правило
    // `[data-rich-line]:empty::before` (richLine.css), а `:empty` — это «ни одного
    // ребёнка», не «нет текста». Стирая последний символ, браузер оставляет за собой
    // остаток: служебный <br> либо опустевший <span> той разметки, что была на тексте, —
    // и подсказка не возвращается, хотя строка пуста. Ресинк ниже её не чинит: модель
    // пуста, текст пуст, расхождения нет, и он выходит первой же строкой.
    //
    // Заодно это делает досев предсказуемым: следующий символ набирается заново, с
    // марками своего типа, а не тем, что случайно уцелело от прошлого текста.
    if (!spans.length && el.firstChild) {
      el.replaceChildren()
      if (el.ownerDocument.activeElement === el) setCaret(el, 0)
    }
    // last — что говорит ПОВЕРХНОСТЬ, поэтому досев марок сюда не идёт: расхождение с
    // моделью и есть то, чем ресинк ниже перепечатывает первый символ уже жирным (и
    // возвращает каретку — она в координатах плоского текста, а досев их не двигает).
    last.current = spans
    const { value: text, caret } = richCaret(el).text()
    // Досев — только когда строка БЫЛА пуста: дальше оформление ведёт браузер, продолжая
    // соседний кусок. Условие здесь, а не в помощнике: «пусто» — это про модель до
    // правки, и знает о ней только строка.
    onChange(value.length === 0 ? applyDefaultMarks(spans, defaultMarks) : spans, caret)
    syncMention(text, caret)
  }

  // Ведёт инлайн-«@» по плоскому тексту и позиции каретки — ровно так же, как BlockRow
  // ведёт слеш-меню, и в тех же координатах.
  //
  // ТРИГГЕР — «@» В НАЧАЛЕ СЛОВА (начало строки либо пробел перед ним). Иначе меню
  // открывалось бы посреди набора почты: «ivan@» в тексте вопроса — обычное дело, и
  // всплывающий там список вопросов был бы дефектом, а не подсказкой.
  function syncMention(text: string, pos: number): void {
    if (!mentionSources) return
    setAtIndex(0)
    setAt((cur) => {
      if (cur) {
        // Каретка ушла за «@» или сам «@» стёрли — меню закрыто, набранное остаётся
        // текстом. Пробел в фильтре тоже закрывает: имя вопроса бывает из двух слов, но
        // тогда автор дописывает его уже без меню, а не ищет по фразе.
        if (pos <= cur.start || text[cur.start] !== '@') return null
        const query = text.slice(cur.start + 1, pos)
        if (/\s/.test(query)) return null
        return query === cur.query ? cur : { start: cur.start, query }
      }
      if (pos === 0 || text[pos - 1] !== '@') return null
      const before = pos >= 2 ? text[pos - 2] : undefined
      return before === undefined || /\s/.test(before) ? { start: pos - 1, query: '' } : null
    })
  }

  const closeMention = () => setAt(null)

  // Выбор источника: вырезаем «@» с набранным фильтром и ставим на его место чип.
  //
  // Работает как `apply` и по той же причине: строка НЕуправляемая, и ресинк из стора
  // придёт с кареткой, снятой ДО правки, — то есть встанет в конец стёртого фильтра.
  // Поэтому поверхность перепечатывается и каретка ставится здесь же, за чипом, а
  // наружу уходит уже готовая модель.
  function pickMention(item: MentionItem): void {
    const el = ref.current
    if (!el || !at) return
    const end = at.start + 1 + at.query.length
    const next = insertMention(
      cutRange(spansFromDom(el), at.start, end),
      at.start,
      item.label,
      item.id,
    )
    if (next.length > MAX_SPANS) {
      toast.error(`В одной строке не больше ${MAX_SPANS} кусков оформления`)
      return
    }
    spansToDom(el, next)
    // Каретка встаёт ЗА ПРОБЕЛОМ, который вставка поставила следом за чипом (insertMention).
    // Не «в конец имени»: то смещение разрешается ВНУТРЬ узла чипа, а он
    // contenteditable=false — каретки там браузер не рисует, и печатать автору некуда
    // (найдено владельцем в браузере). Пробел за чипом есть всегда, поэтому смещение
    // ниже всегда попадает в обычный, редактируемый текстовый узел.
    const caret = at.start + item.label.length + 1
    el.focus({ preventScroll: true })
    setCaret(el, caret)
    last.current = next
    onChange(next, caret, 'mention')
    setAt(null)
  }

  // apply — команда форматирования: над МОДЕЛЬЮ, не над DOM. Выделение восстанавливается
  // по смещениям в плоском тексте: DOM-позиции после разрезания спанов другие, а
  // смещения — те же, поэтому выделение переживает наложение марки и его видно на месте.
  //
  // Диапазон: пока фокус В СТРОКЕ, источник — живое выделение, и только оно. Снимок
  // состояния для этого не годится, хотя он всегда под рукой: он приезжает из
  // `selectionchange` через React, то есть на кадр ПОЗЖЕ нажатия, и аккорд ставил бы
  // марку на предыдущее выделение. Найдено e2e этапа 14.5: `Shift+←` трижды и `Mod+B`
  // красили один символ из трёх, а с паузами между нажатиями — два из трёх (отставание
  // ровно на столько событий, сколько React не успел свести).
  //
  // Снимок нужен в обратном случае — фокус ушёл из строки в панель (поле адреса,
  // выборщик цвета): живого выделения там уже нет, и диапазон помнит только он.
  function apply(f: (s: Span[], from: number, to: number) => Span[]): void {
    const el = ref.current
    if (!el) return
    const range = el.ownerDocument.activeElement === el ? selectionRange(el) : sel
    if (!range) return
    const spans = f(spansFromDom(el), range.from, range.to)
    // Число кусков ограничено схемой, и упереться в лимит может только ФОРМАТИРОВАНИЕ:
    // набор его не увеличивает вовсе (канон склеивает соседей с одинаковым стилем), а
    // каждая марка на середину куска режет его на три. Пропустить перебор дальше значит
    // отдать его автосейву, который получит 422 и покажет автору «ошибка сохранения» —
    // ни причины, ни того, какая именно правка её вызвала.
    if (spans.length > MAX_SPANS) {
      toast.error(`В одной строке не больше ${MAX_SPANS} кусков оформления`, {
        description: 'Часть текста придётся оформить единообразно.',
      })
      return
    }
    spansToDom(el, spans)
    setSelection(el, range.from, range.to)
    last.current = spans
    // Плоский текст форматирование не меняет, но модель — меняет: отдаём наружу, иначе
    // разметка не доедет ни до автосейва, ни до истории отмены.
    onChange(spans, range.to, 'format')
    // Форматирование меняет и модель, и «что нажато» в панели. Пересчитываем сразу, а
    // не ждём `selectionchange`: восстановление выделения его не гарантирует. Поверхность
    // к этому моменту уже перепечатана и выделение восстановлено, поэтому читается она,
    // а не передаётся снимок модели.
    syncSelection()
  }

  // Shift+Enter — перенос строки внутри блока (решение владельца 2026-08-22: жест
  // «новый блок внутрь вопроса» снят, у клавиши остаётся текстовое поведение).
  //
  // Работает как `pickMention` и по той же причине: строка НЕуправляемая, ресинк из
  // стора придёт с кареткой, снятой ДО правки, — поэтому поверхность перепечатывается и
  // каретка ставится здесь же, за переносом, а наружу уходит готовая модель.
  //
  // Символ `\n`, а не <br> браузера: <br> не считается символом в `textContent`, то есть
  // в координатах, которыми поток строки, слеш-меню и форматирование адресуют текст
  // (`insertText`). Своя история отмены переносу не нужна — `kind` не передаём, и он
  // коалесится с набором вокруг, как обычный символ.
  function breakLine(el: HTMLDivElement): void {
    const sel = selectionRange(el)
    const spans = spansFromDom(el)
    const at = sel ? sel.from : richCaret(el).text().caret
    const next = insertText(sel ? cutRange(spans, sel.from, sel.to) : spans, at, '\n')
    spansToDom(el, next)
    const caret = at + 1
    setCaret(el, caret)
    last.current = next
    onChange(next, caret)
    // Перенос — правка текста: «@»-меню ведётся по плоскому тексту и позиции каретки,
    // и без пересчёта осталось бы открытым с устаревшим фильтром.
    syncMention(plainText(next), caret)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    // Открытое «@»-меню забирает навигацию — как слеш-меню в строке полотна: ↑/↓ по
    // пунктам, Enter — выбор, Esc — закрыть (набранное остаётся текстом). Backspace
    // уходит нативному вводу: он сотрёт символ, а `commit` пересчитает фильтр или
    // закроет меню.
    if (menuOpen) {
      if (chords.arrowDown(e)) {
        e.preventDefault()
        return setAtIndex((i) => (items.length ? (i + 1) % items.length : 0))
      }
      if (chords.arrowUp(e)) {
        e.preventDefault()
        return setAtIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0))
      }
      if (chords.enter(e)) {
        e.preventDefault()
        const item = items[atIndex]
        if (item) pickMention(item)
        return
      }
      if (chords.escape(e)) {
        e.preventDefault()
        return closeMention()
      }
    }
    // Форматирование — до потока строки. Mod+B/I/U гасим ЯВНО и останавливаем всплытие:
    //   • без preventDefault браузер сам применит своё жирное внутри contenteditable и
    //     вставит теги мимо модели;
    //   • без stopPropagation Mod+B доедет до вендоренного сайдбара shadcn (слушатель
    //     на window, `components/ui/sidebar.tsx`) и схлопнет его заодно с жирным.
    // Аккорд забирает себе только текстовая строка — в остальном кабинете Mod+B
    // по-прежнему сайдбар.
    const mark: Mark | null = markChord(e)
    if (mark) {
      e.preventDefault()
      e.stopPropagation()
      return apply((s, from, to) => toggleMark(s, from, to, mark))
    }
    // Mod+K открывает поле адреса, а не применяет значение вслепую: у ссылки есть
    // значение, и «поставить ссылку» без него — жест без результата.
    if (chords.link(e)) {
      e.preventDefault()
      e.stopPropagation()
      // Снимок обновляем ЯВНО, по живому выделению: поле адреса сейчас заберёт фокус,
      // и применять марку придётся уже по снимку — значит он обязан быть свежим. По
      // той же причине и открытие панели решает живое выделение, а не состояние: оно
      // на кадр моложе (см. `apply`).
      const el = e.currentTarget
      if (!selectionRange(el)) return
      syncSelection()
      setLinkOpen(true)
      return
    }
    // Перенос строки — до потока полотна: `chords.enter` его уже не ловит (Shift
    // исключён явно), но браузеру отдавать нельзя — он вставит <br> мимо модели.
    if (chords.lineBreak(e) || (enterBreaksLine && plainEnter(e))) {
      e.preventDefault()
      return breakLine(e.currentTarget)
    }
    onKeyDown(e)
  }

  const surface = (
    <div
      ref={(el) => {
        ref.current = el
        elRef(el)
      }}
      data-rich-line=""
      data-ph={placeholder}
      data-painted={
        sel && painted && painted.from === sel.from && painted.to === sel.to ? '' : undefined
      }
      // Метка «эта строка набирается жирным» — для вида ПОДСКАЗКИ (richLine.css). Из тех
      // же defaultMarks, что и досев: подсказка обязана показывать текст таким, каким он
      // родится, иначе она обещает обычный вес, а автор получает жирный.
      data-bold={defaultMarks.includes('b') ? '' : undefined}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      role="textbox"
      aria-label={label}
      tabIndex={readOnly ? -1 : 0}
      className={className}
      onInput={() => {
        if (composing.current) return
        commit()
      }}
      onCompositionStart={() => {
        composing.current = true
      }}
      onCompositionEnd={() => {
        composing.current = false
        commit()
      }}
      onPaste={(e) => {
        // Вставка приводится к plain text (§3.2 спеки, осознанная граница v1): разбор
        // чужого HTML из Word/Docs — самостоятельная задача со своим списком ловушек,
        // в демо-критерий фазы она не входит и записана в BACKLOG. Переносы вставка
        // по-прежнему схлопывает в пробелы, хотя сама строка с 2026-08-22 многострочная:
        // текст сюда кладёт `execCommand`, и что он сделает с `\n` — вопрос браузера, а
        // не наш. Многострочная вставка едет тем же пунктом BACKLOG.
        e.preventDefault()
        const text = e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' ')
        if (!text) return
        e.currentTarget.ownerDocument.execCommand('insertText', false, text)
      }}
      onKeyDown={handleKeyDown}
      onFocus={onFocus}
      onBlur={(e) => {
        // Уход фокуса ИЗ строки в панель — не уход: панель гасит mousedown, но поле
        // адреса ссылки фокус берёт намеренно. Без этой проверки панель исчезала бы
        // ровно в тот момент, когда автор в неё целится.
        if (
          e.relatedTarget instanceof HTMLElement &&
          e.relatedTarget.closest('[data-format-bar]')
        ) {
          return
        }
        setSel(null)
        setLinkOpen(false)
        onBlur(e)
      }}
    />
  )

  return (
    <>
      {mentionSources ? (
        <MentionMenu
          open={menuOpen}
          items={items}
          activeIndex={atIndex}
          onActiveChange={setAtIndex}
          onPick={pickMention}
          onClose={closeMention}
        >
          {surface}
        </MentionMenu>
      ) : (
        surface
      )}
      {sel && (
        <FormatBar
          rect={sel.rect}
          active={sel.active}
          href={sel.href}
          linkOpen={linkOpen}
          onLinkOpenChange={setLinkOpen}
          // Выборщик цвета держит фокус у себя, пока автор выбирает: вернуть его в
          // строку — работа строки, она же знает диапазон, который надо подсветить
          // обратно.
          onReturnFocus={() => {
            const el = ref.current
            if (!el) return
            el.focus({ preventScroll: true })
            setSelection(el, sel.from, sel.to)
          }}
          onToggleMark={(m) => apply((s, from, to) => toggleMark(s, from, to, m))}
          onColor={(c) => {
            setPainted({ from: sel.from, to: sel.to })
            apply((s, from, to) => setColor(s, from, to, c))
          }}
          onBg={(c) => {
            setPainted({ from: sel.from, to: sel.to })
            apply((s, from, to) => setBg(s, from, to, c))
          }}
          onLink={(href) => apply((s, from, to) => setHref(s, from, to, href))}
        />
      )}
    </>
  )
}
