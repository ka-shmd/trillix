// ПРОБА ЭТАПА 14.0 (DEV-PLAN, фаза 14). Модель богатого текста и её перевод в DOM и
// обратно. Проба отвечает на один вопрос: живёт ли contenteditable за адаптером каретки,
// не ломая клавиатурный поток фазы 13 и не роняя каретку на ре-рендере полотна. В
// поставку каталог `spike/` не входит: подтвердится — переезжает в контракт (этап 14.1)
// и в `@fields`, не подтвердится — удаляется целиком вместе с решением.
//
// Формат — §2.2 спеки `docs/DESIGN-rich-text.md`: булевы марки списком, значимые своими
// полями. Здесь взяты по одной каждого рода (`b` и `color`) — ровно чтобы проверить, что
// обе механики работают; остальные пять марок фазы добавляются строкой в MARKS и полем
// в Style, и это само по себе часть проверяемого (§1 спеки: следующая марка стоит три
// строки).

// Булевы марки. Проба несёт одну; список открыт по построению.
export const MARKS = ['b'] as const
export type Mark = (typeof MARKS)[number]

export interface Span {
  t: string
  m?: Mark[]
  color?: string
}

// Style — оформление куска без самого текста. Отдельный тип, потому что все операции
// (сравнение, склейка, наложение) работают именно с ним, а не со спаном целиком.
export interface Style {
  m?: Mark[]
  color?: string
}

const styleOf = (s: Span): Style => ({ m: s.m, color: s.color })

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
  (canonMarks(a.m) ?? []).join(',') === (canonMarks(b.m) ?? []).join(',')

const mkSpan = (t: string, st: Style): Span => {
  const s: Span = { t }
  const m = canonMarks(st.m)
  if (m) s.m = m
  if (st.color) s.color = st.color
  return s
}

export const plainText = (spans: Span[]): string => spans.map((s) => s.t).join('')

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

export const toggleMark = (spans: Span[], from: number, to: number, mark: Mark): Span[] => {
  const on = !hasMarkThroughout(spans, from, to, mark)
  return restyle(spans, from, to, (st) => ({
    ...st,
    m: on ? [...(st.m ?? []), mark] : (st.m ?? []).filter((x) => x !== mark),
  }))
}

export const setColor = (spans: Span[], from: number, to: number, color?: string): Span[] =>
  restyle(spans, from, to, (st) => ({ ...st, color }))

// ---------- DOM ↔ модель ----------

// spansToDom печатает модель в поверхность. Кусок без стиля — голый текстовый узел (а не
// <span> с пустыми атрибутами): так DOM остаётся минимальным, а браузер при наборе не
// плодит обёрток вокруг обёрток.
// markClass — вид булевой марки задаёт КЛАСС, а не атрибут: так вид описывается одной
// строкой CSS и в фазе переезжает в `fields.css` (`rf-b`/`rf-i`/…) общим на три
// поверхности, как требует §3.1 спеки.
export const markClass = (m: Mark): string => `rf-${m}`

export function spansToDom(root: HTMLElement, spans: Span[]): void {
  root.textContent = ''
  const doc = root.ownerDocument
  for (const s of spans) {
    const st = styleOf(s)
    if (!st.m?.length && !st.color) {
      root.appendChild(doc.createTextNode(s.t))
      continue
    }
    const el = doc.createElement('span')
    if (st.m?.length) el.className = st.m.map(markClass).join(' ')
    if (st.color) {
      // Значение марки хранится в data-атрибуте, а вид — в инлайн-стиле. Разделение
      // не косметика: браузер нормализует `style.color` при ЧТЕНИИ («#c026d3» →
      // «rgb(192, 38, 211)»), и модель, собранная обратно из стиля, приезжала бы в
      // схему в форме, которую валидатор `^#[0-9a-f]{6}$` обязан отвергнуть.
      // data-атрибут возвращается тем же, чем записан.
      el.dataset.color = st.color
      el.style.color = st.color
    }
    el.textContent = s.t
    root.appendChild(el)
  }
}

// spansFromDom читает поверхность обратно в модель. Стиль наследуется вглубь: браузер при
// наборе на границе умеет вкладывать <span> в <span>, и плоская модель обязана это
// пережить, а не считать вложенность ошибкой.
export function spansFromDom(root: HTMLElement): Span[] {
  const out: Span[] = []
  const walk = (node: Node, inherited: Style): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        out.push(mkSpan(child.textContent ?? '', inherited))
        continue
      }
      if (!(child instanceof HTMLElement)) continue
      // <br> — единственный элемент без текста, который сюда попадает (перенос строки
      // из вставки). Строка полотна однострочная, поэтому перенос превращается в пробел.
      if (child.tagName === 'BR') {
        out.push(mkSpan(' ', inherited))
        continue
      }
      const own: Style = {
        m: [...(inherited.m ?? []), ...MARKS.filter((mk) => child.classList.contains(markClass(mk)))],
        // Только data-атрибут: `style.color` браузер отдаёт нормализованным (см.
        // комментарий в spansToDom), и модель поехала бы в схему в форме rgb().
        color: child.dataset.color || inherited.color,
      }
      walk(child, own)
    }
  }
  walk(root, {})
  return normalize(out)
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
