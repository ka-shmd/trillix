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
  cutRange,
  insertMention,
  setBg,
  setColor,
  setHref,
  spansFromDom,
  spansToDom,
  toggleMark,
} from './richText'
import { MentionMenu, type MentionItem } from './MentionMenu'
import { sourceLabel, sourcesFor } from './logic/model'
import { useBuilderStore } from './storeContext'
import {
  richCaret,
  selectionRange,
  selectionRect,
  setCaret,
  setCaretAfterNode,
  setSelection,
} from './richCaret'
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
  // id блока, которому принадлежит строка. Есть — в строке работает подстановка ответа
  // по «@» (docs/design/mentions.md); нет — не работает вовсе. Заголовку формы её не
  // передают намеренно: он стоит первой строкой документа, вопросов выше него не бывает,
  // и меню там показывало бы пустоту всегда.
  mentionsFor?: string
}

// Пустой список источников — СТАБИЛЬНАЯ ссылка. Селектор стора возвращает её, пока
// подстановка строке не нужна (чипов нет и меню закрыто): свежий массив на каждый вызов
// означал бы ре-рендер этой строки на каждую правку ЛЮБОГО блока полотна — ровно тот
// механизм, которым фаза 21 дважды роняла перф (STATUS, «подписка на s.blocks»).
const NO_BLOCKS: never[] = []

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
  mentionsFor,
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
  // Инлайн-«@» (mentions.md §7) — та же машинерия, что у слеш-меню в BlockRow: `at`
  // это null (закрыто) либо {start, query}, где start — индекс «@» в ПЛОСКОМ тексте, а
  // query — набранное после него до каретки. Живёт здесь, а не в строке полотна,
  // потому что вставка чипа — операция над текстом: ей нужны модель, каретка и DOM,
  // которыми владеет эта поверхность (слеш-меню, наоборот, меняет ТИП блока — операция
  // строки).
  const [at, setAt] = useState<{ start: number; query: string } | null>(null)
  const [atIndex, setAtIndex] = useState(0)
  const menuOpen = at !== null
  // Документ нужен строке в двух случаях: пока открыто меню (собрать список вопросов) и
  // пока в строке есть хоть один чип (пометить те, что перестали разрешаться). В
  // остальное время селектор отдаёт стабильную пустоту и строка на правки документа не
  // реагирует.
  const needsDoc = Boolean(mentionsFor) && (menuOpen || value.some((s) => s.ref))
  const docBlocks = useBuilderStore((s) => (needsDoc ? s.blocks : NO_BLOCKS))
  // Что вообще можно подставить в эту строку: отвечаемые вопросы ВЫШЕ неё. Правило и
  // функция — те же, что у условной логики: одна модель на две возможности, автору
  // нечего запоминать.
  const sources = useMemo(
    () => (needsDoc && mentionsFor ? sourcesFor(docBlocks, mentionsFor) : NO_BLOCKS),
    [needsDoc, mentionsFor, docBlocks],
  )
  // Имена считаются ТОЛЬКО пока меню открыто: derivedQuestionName проходит по документу
  // ради каждого источника, и делать это на каждую правку любого блока ради чипа,
  // который и так знает своё имя, незачем.
  const items: MentionItem[] = useMemo(() => {
    if (!menuOpen) return []
    const q = (at?.query ?? '').trim().toLowerCase()
    return sources
      .map((b) => ({ id: b.id, label: sourceLabel(docBlocks, b) }))
      .filter((it) => q === '' || it.label.toLowerCase().includes(q))
  }, [menuOpen, at?.query, sources, docBlocks])

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
    const live = new Set(sources.map((b) => b.id))
    for (const chip of el.querySelectorAll<HTMLElement>('[data-ref]')) {
      if (live.has(chip.dataset.ref ?? '')) delete chip.dataset.dead
      else chip.dataset.dead = ''
    }
  }, [sources, value])

  // commit — единственный путь наружу: сериализуем поверхность в модель и отдаём её
  // вместе с позицией каретки.
  function commit(): void {
    const el = ref.current
    if (!el) return
    const spans = spansFromDom(el)
    last.current = spans
    const { value: text, caret } = richCaret(el).text()
    onChange(spans, caret)
    syncMention(text, caret)
  }

  // Ведёт инлайн-«@» по плоскому тексту и позиции каретки — ровно так же, как BlockRow
  // ведёт слеш-меню, и в тех же координатах.
  //
  // ТРИГГЕР — «@» В НАЧАЛЕ СЛОВА (начало строки либо пробел перед ним). Иначе меню
  // открывалось бы посреди набора почты: «ivan@» в тексте вопроса — обычное дело, и
  // всплывающий там список вопросов был бы дефектом, а не подсказкой.
  function syncMention(text: string, pos: number): void {
    if (!mentionsFor) return
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
    // Каретка встаёт ЗА чипом, а не на смещение «конец имени»: то смещение попадает
    // внутрь узла чипа, а он contenteditable=false — каретки там браузер не рисует, и
    // после вставки автору некуда печатать (найдено владельцем в браузере).
    //
    // Узел ищется по позиции в модели: spansToDom печатает по узлу на кусок и в том же
    // порядке, а чип по построению начинается ровно на at.start.
    let idx = 0
    let pos = 0
    for (const [i, s] of next.entries()) {
      if (pos === at.start) {
        idx = i
        break
      }
      pos += s.t.length
    }
    const chipNode = el.childNodes[idx]
    el.focus({ preventScroll: true })
    if (chipNode) setCaretAfterNode(el, chipNode)
    const caret = at.start + item.label.length
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
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label={label}
      tabIndex={0}
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
        // в демо-критерий фазы она не входит и записана в BACKLOG. Строка однострочная,
        // поэтому переносы становятся пробелами.
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
      {mentionsFor ? (
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
          onColor={(c) => apply((s, from, to) => setColor(s, from, to, c))}
          onBg={(c) => apply((s, from, to) => setBg(s, from, to, c))}
          onLink={(href) => apply((s, from, to) => setHref(s, from, to, href))}
        />
      )}
    </>
  )
}
