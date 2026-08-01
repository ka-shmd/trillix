import { MARKS, type Mark, type Span } from '@entities/formSchema'

// Редакторская сторона богатого текста (фаза 14, этап 14.3): операции над моделью и
// перевод модели в DOM и обратно. Сам ФОРМАТ живёт в контракте
// (`@entities/formSchema` ↔ `internal/domain/spans.go`) — здесь только то, что нужно
// редактору и не нужно ни рендереру, ни серверу. Поэтому модуль в билдере, а не в
// `web/shared`: тащить разрезание спанов в бюджет рендерера незачем, он их только
// печатает.
//
// Обоснование формата и инвариантов — `docs/design/rich-text.md` §2.

// Style — оформление куска без самого текста. Отдельный тип, потому что все операции
// (сравнение, склейка, наложение) работают именно с ним, а не со спаном целиком.
// Ссылка живёт здесь же: в плоской модели она — такой же атрибут куска, как цвет.
export interface Style {
  m?: Mark[]
  color?: string
  bg?: string
  href?: string
}

const styleOf = (s: Span): Style => ({ m: s.m, color: s.color, bg: s.bg, href: s.href })

// Марки хранятся отсортированными: канон делает сравнение стилей дешёвым (строковое
// равенство после join) и избавляет от «те же марки в другом порядке — другой спан»,
// из-за которого склейка соседей молча переставала работать.
const canonMarks = (m: Mark[] | undefined): Mark[] | undefined => {
  if (!m || m.length === 0) return undefined
  const uniq = [...new Set(m)].filter((x): x is Mark => (MARKS as readonly string[]).includes(x))
  return uniq.length ? uniq.sort() : undefined
}

export const sameStyle = (a: Style, b: Style): boolean =>
  (a.color ?? '') === (b.color ?? '') &&
  (a.bg ?? '') === (b.bg ?? '') &&
  (a.href ?? '') === (b.href ?? '') &&
  (canonMarks(a.m) ?? []).join(',') === (canonMarks(b.m) ?? []).join(',')

const mkSpan = (t: string, st: Style): Span => {
  const s: Span = { t }
  const m = canonMarks(st.m)
  if (m) s.m = m
  if (st.color) s.color = st.color
  if (st.bg) s.bg = st.bg
  if (st.href) s.href = st.href
  return s
}

// normalize приводит к канону: пустые куски выброшены, соседние с одинаковым стилем
// склеены. Это обязанность РЕДАКТОРА, а не валидатора (§2.3 спеки): схема с двумя
// подряд одинаковыми кусками валидна, иначе undo и промежуточные состояния набора
// ловили бы 422 в автосейве.
export function normalize(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of spans) {
    if (s.t === '') continue
    const prev = out[out.length - 1]
    if (prev && sameStyle(styleOf(prev), styleOf(s))) {
      prev.t += s.t
      continue
    }
    out.push(mkSpan(s.t, styleOf(s)))
  }
  return out
}

// restyle — единственная операция над моделью: наложить преобразование стиля на
// полуинтервал [from, to) плоского текста. Все команды форматирования выражаются через
// неё, поэтому новая марка не приносит своего кода разрезания спанов.
export function restyle(spans: Span[], from: number, to: number, f: (st: Style) => Style): Span[] {
  if (to <= from) return spans
  const out: Span[] = []
  let pos = 0
  for (const s of spans) {
    const start = pos
    const end = pos + s.t.length
    pos = end
    // Кусок целиком вне выделения — как был.
    if (end <= from || start >= to) {
      out.push(s)
      continue
    }
    const st = styleOf(s)
    const cutL = Math.max(from - start, 0)
    const cutR = Math.min(to - start, s.t.length)
    if (cutL > 0) out.push(mkSpan(s.t.slice(0, cutL), st))
    out.push(mkSpan(s.t.slice(cutL, cutR), f(st)))
    if (cutR < s.t.length) out.push(mkSpan(s.t.slice(cutR), st))
  }
  return normalize(out)
}

// hasMarkThroughout — марка стоит на ВСЁМ выделении. Условие переключателя: «снять»
// только когда стоит везде, иначе «поставить» (так ведут себя все редакторы, и так
// частично размеченное выделение доводится до однородного одним нажатием).
export function hasMarkThroughout(spans: Span[], from: number, to: number, mark: Mark): boolean {
  if (to <= from) return false
  // Диапазон вне текста не покрыт НИ ОДНИМ куском, а «нет контрпримера» для пустого
  // обхода означало бы «марка стоит везде» — и переключатель пошёл бы её снимать.
  // Сейчас такой диапазон недостижим (from/to приходят из живого выделения), но
  // инвариант держался только на этом, а стоит одну строку.
  if (from >= spans.reduce((n, s) => n + s.t.length, 0)) return false
  let pos = 0
  for (const s of spans) {
    const start = pos
    const end = pos + s.t.length
    pos = end
    if (end <= from || start >= to) continue
    if (!s.m?.includes(mark)) return false
  }
  return true
}

export const toggleMark =(spans: Span[], from: number, to: number, mark: Mark): Span[] => {
  const on = !hasMarkThroughout(spans, from, to, mark)
  return restyle(spans, from, to, (st) => ({
    ...st,
    m: on ? [...(st.m ?? []), mark] : (st.m ?? []).filter((x) => x !== mark),
  }))
}

// cutRange — вырезать полуинтервал [from, to) плоского текста, сохранив оформление
// остатка. Нужно инлайн-слешу: «/» и набранный фильтр могли оказаться внутри
// размеченного куска, и склейка строк заново («до» + «после») стёрла бы разметку всей
// подписи. Разрезание — то же, что в restyle, только середина выбрасывается.
export function cutRange(spans: Span[], from: number, to: number): Span[] {
  if (to <= from) return spans
  const out: Span[] = []
  let pos = 0
  for (const s of spans) {
    const start = pos
    const end = pos + s.t.length
    pos = end
    if (end <= from || start >= to) {
      out.push(s)
      continue
    }
    const st = styleOf(s)
    const cutL = Math.max(from - start, 0)
    const cutR = Math.min(to - start, s.t.length)
    if (cutL > 0) out.push(mkSpan(s.t.slice(0, cutL), st))
    if (cutR < s.t.length) out.push(mkSpan(s.t.slice(cutR), st))
  }
  return normalize(out)
}

// Значимые марки: пустое значение СНИМАЕТ марку (mkSpan не пишет пустых полей).
export const setColor = (spans: Span[], from: number, to: number, color?: string): Span[] =>
  restyle(spans, from, to, (st) => ({ ...st, color }))

export const setBg = (spans: Span[], from: number, to: number, bg?: string): Span[] =>
  restyle(spans, from, to, (st) => ({ ...st, bg }))

export const setHref = (spans: Span[], from: number, to: number, href?: string): Span[] =>
  restyle(spans, from, to, (st) => ({ ...st, href }))

// ---------- DOM ↔ модель ----------

// markClass — вид булевой марки задаёт КЛАСС, а не атрибут. Те же классы печатает
// `RichText` в `@fields/BlockField`, а сам вид живёт в `fields.css` — один на три
// поверхности. Правило в CSS кабинета означало бы, что опубликованная форма теряет
// жирный (рендерер про стили кабинета не знает) — так уже было в пробе 14.0.
export const markClass = (m: Mark): string => `rf-${m}`

// spansToDom печатает модель в поверхность. Кусок без стиля — голый текстовый узел (а не
// <span> с пустыми атрибутами): так DOM остаётся минимальным, а браузер при наборе не
// плодит обёрток вокруг обёрток.
//
// Значения марок хранятся в data-атрибутах, а вид — в инлайн-стиле. Разделение не
// косметика: браузер нормализует `style.color` при ЧТЕНИИ («#c026d3» → «rgb(192, 38,
// 211)»), и модель, собранная обратно из стиля, приезжала бы в схему в форме, которую
// валидатор `^#[0-9a-f]{6}$` обязан отвергнуть.
export function spansToDom(root: HTMLElement, spans: Span[]): void {
  root.textContent = ''
  const doc = root.ownerDocument
  for (const s of spans) {
    const st = styleOf(s)
    if (!st.m?.length && !st.color && !st.bg && !st.href) {
      root.appendChild(doc.createTextNode(s.t))
      continue
    }
    const el = doc.createElement('span')
    if (st.m?.length) el.className = st.m.map(markClass).join(' ')
    if (st.color) {
      el.dataset.color = st.color
      el.style.color = st.color
    }
    if (st.bg) {
      el.dataset.bg = st.bg
      el.style.backgroundColor = st.bg
    }
    // Ссылка внутри РЕДАКТИРУЕМОЙ строки — не <a>: кликабельная ссылка посреди
    // contenteditable уводит со страницы по случайному клику и мешает выделению.
    // Адрес живёт в data-атрибуте, вид — классом `rf-link`; настоящий <a> рисует
    // `RichText` у респондента.
    if (st.href) {
      el.dataset.href = st.href
      el.classList.add('rf-link')
    }
    el.textContent = s.t
    root.appendChild(el)
  }
}

// styleOfEl — оформление элемента поверхности вместе с унаследованным. Наследование
// вглубь — не поблажка, а требование: браузер при наборе на границе вкладывает <span> в
// <span>, и плоская модель обязана это пережить. Снять цвет вложенным элементом нельзя
// (пустой data-атрибут читается как «не задано»), и это верно: сами мы вложенности не
// печатаем — `spansToDom` кладёт куски рядом, — а браузер, клонируя узел, клонирует и
// значение вместе с ним.
function styleOfEl(el: HTMLElement, inherited: Style): Style {
  return {
    m: [...(inherited.m ?? []), ...MARKS.filter((mk) => el.classList.contains(markClass(mk)))],
    // Только data-атрибуты: инлайн-стиль браузер отдаёт нормализованным.
    color: el.dataset.color || inherited.color,
    bg: el.dataset.bg || inherited.bg,
    href: el.dataset.href || inherited.href,
  }
}

// spansFromDom читает поверхность обратно в модель. Стиль наследуется вглубь: браузер при
// наборе на границе умеет вкладывать <span> в <span>, и плоская модель обязана это
// пережить, а не считать вложенность ошибкой.
//
// <br> разбирается ОТЛОЖЕННО, и это не мелочь. Строка однострочная, поэтому перенос
// посреди текста — пробел; но ХВОСТОВОЙ <br> ставит сам браузер, когда автор стёр
// строку дочиста (без него пустой contenteditable схлопывается по высоте), и он не
// перенос вовсе. Пока он читался пробелом, опустошить строку было нельзя: `commit`
// клал в стор пробел, ресинк видел расхождение плоского текста с DOM и писал этот
// пробел обратно уже настоящим, а подсказка пустой строки (`:empty`) не возвращалась.
// Поэтому решение принимается после обхода, когда видно, есть ли за <br> ещё текст.
export function spansFromDom(root: HTMLElement): Span[] {
  // `{ br }` — место, где стоял <br>, вместе со стилем, действовавшим на этом месте;
  // чем оно станет, решается ниже.
  const raw: (Span | { br: Style })[] = []
  const isBr = (p: Span | { br: Style }): p is { br: Style } => 'br' in p
  const out: Span[] = []
  const walk = (node: Node, inherited: Style): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const t = child.textContent ?? ''
        // Пустые текстовые узлы не копим: их и так выбросил бы канон, но здесь они
        // вдобавок мешали бы увидеть, что <br> — хвостовой.
        if (t !== '') raw.push(mkSpan(t, inherited))
        continue
      }
      if (!(child instanceof HTMLElement)) continue
      if (child.tagName === 'BR') {
        raw.push({ br: inherited })
        continue
      }
      walk(child, styleOfEl(child, inherited))
    }
  }
  walk(root, {})

  // Хвостовые <br> — служебные, их не существует для модели. Остальные — пробелы, и
  // стиль они берут тот, что был в силе на их месте: иначе пробел между двумя жирными
  // кусками не склеился бы с соседями и текст поехал бы на три спана вместо одного.
  let end = raw.length
  while (end > 0 && isBr(raw[end - 1]!)) end--
  for (let i = 0; i < end; i++) {
    const piece = raw[i]!
    out.push(isBr(piece) ? mkSpan(' ', piece.br) : piece)
  }
  return normalize(out)
}

// activeStyle — что стоит на ВСЁМ полуинтервале [from, to): булевы марки и общий адрес
// ссылки. Ровно то, что нужно панели форматирования, и ничего больше.
//
// Читает DOM НАПРЯМУЮ, а не через `spansFromDom`. Это не микрооптимизация: панель
// пересчитывается на каждый `selectionchange`, то есть на каждом кадре протяжки мышью,
// а сборка модели ради двух ответов означала обход дерева, канон со склейкой соседей и
// N новых объектов — всё немедленно выброшенное, — плюс пять отдельных проходов по
// готовому массиву (по одному на марку и один на ссылку). Здесь один обход и ни одной
// аллокации на кусок текста.
//
// Координаты — те же, что у `caretOffset`: длина считается по текстовым узлам, <br>
// пропускается. Иначе панель отвечала бы про другой диапазон, чем тот, к которому
// применится команда.
export function activeStyle(
  root: HTMLElement,
  from: number,
  to: number,
): { marks: ReadonlySet<Mark>; href?: string } {
  // Марки выбывают по контрпримеру: стартуем со всех и вычёркиваем те, которых нет на
  // очередном куске. Пустое пересечение — единственный честный ответ для диапазона, не
  // накрывшего ни одного куска.
  const marks = new Set<Mark>(MARKS)
  let href: string | undefined
  let first = true
  let pos = 0

  const walk = (node: Node, inherited: Style): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const start = pos
        pos += (child.textContent ?? '').length
        // Строгое пересечение: кусок, лишь примыкающий к границе выделения, в него не
        // входит и на «нажатость» кнопки влиять не должен.
        if (pos <= from || start >= to) continue
        for (const m of marks) if (!inherited.m?.includes(m)) marks.delete(m)
        if (first) {
          href = inherited.href
          first = false
        } else if (href !== inherited.href) {
          href = undefined
        }
        continue
      }
      if (!(child instanceof HTMLElement) || child.tagName === 'BR') continue
      walk(child, styleOfEl(child, inherited))
    }
  }
  walk(root, {})
  return { marks: first ? new Set<Mark>() : marks, href: first ? undefined : href }
}

// ---------- каретка в координатах плоского текста ----------

// caretOffset — сколько символов плоского текста лежит ДО точки (node, offset). Именно в
// этих координатах живут все операции: DOM-позиции меняются от разрезания спанов, а
// смещение в тексте — нет, поэтому выделение переживает наложение марки.
export function caretOffset(root: HTMLElement, node: Node, offset: number): number {
  let seen = 0
  let found = -1
  const walk = (n: Node): boolean => {
    if (n === node && n.nodeType !== 3) {
      // Точка задана элементом: offset — индекс дочернего узла, не символа.
      const kids = Array.from(n.childNodes).slice(0, offset)
      found = seen + kids.reduce((acc, k) => acc + (k.textContent ?? '').length, 0)
      return true
    }
    if (n.nodeType === 3) {
      if (n === node) {
        found = seen + offset
        return true
      }
      seen += (n.textContent ?? '').length
      return false
    }
    for (const child of Array.from(n.childNodes)) if (walk(child)) return true
    return false
  }
  walk(root)
  return found < 0 ? seen : found
}

// pointAt — обратный перевод: смещение в плоском тексте → точка DOM. Возвращает конец
// последнего текстового узла, если смещение за пределами (текст укоротился под нами).
export function pointAt(root: HTMLElement, offset: number): { node: Node; offset: number } {
  let seen = 0
  let last: { node: Node; offset: number } = { node: root, offset: 0 }
  const walk = (n: Node): { node: Node; offset: number } | null => {
    if (n.nodeType === 3) {
      const len = (n.textContent ?? '').length
      last = { node: n, offset: len }
      if (seen + len >= offset) return { node: n, offset: offset - seen }
      seen += len
      return null
    }
    for (const child of Array.from(n.childNodes)) {
      const hit = walk(child)
      if (hit) return hit
    }
    return null
  }
  return walk(root) ?? last
}
