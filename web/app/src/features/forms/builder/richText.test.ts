// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { plainText, type Span } from '@entities/formSchema'
import {
  activeStyle,
  applyDefaultMarks,
  caretOffset,
  cutRange,
  hasMarkThroughout,
  insertMention,
  insertText,
  markClass,
  normalize,
  pointAt,
  restyle,
  setColor,
  spansFromDom,
  spansToDom,
  toggleMark,
} from './richText'

// ПРОБА ЭТАПА 14.0 — модель богатого текста. Проверяется ровно то, на чём стоит вся
// конструкция: разрезание спанов по границам выделения, канон (склейка соседей),
// круговой перевод DOM↔модель и координаты каретки в плоском тексте. Всё остальное в
// пробе — обвязка вокруг этих четырёх вещей.

const div = () => document.createElement('div')

describe('канон', () => {
  it('выбрасывает пустые куски и склеивает соседей с одинаковым стилем', () => {
    const out = normalize([{ t: 'аб' }, { t: '' }, { t: 'вг' }, { t: 'д', m: ['b'] }])
    expect(out).toEqual([{ t: 'абвг' }, { t: 'д', m: ['b'] }])
  })

  it('не склеивает куски с разным цветом', () => {
    const out = normalize([
      { t: 'а', color: '#111111' },
      { t: 'б', color: '#222222' },
    ])
    expect(out).toHaveLength(2)
  })
})

describe('restyle — разрезание по границам выделения', () => {
  const src: Span[] = [{ t: 'абвгд' }]

  it('середина: три куска, стиль только у среднего', () => {
    const out = restyle(src, 1, 3, (st) => ({ ...st, m: ['b'] }))
    expect(out).toEqual([{ t: 'а' }, { t: 'бв', m: ['b'] }, { t: 'гд' }])
    expect(plainText(out)).toBe('абвгд')
  })

  it('граница спанов: выделение через два куска красит оба', () => {
    const out = restyle([{ t: 'аб' }, { t: 'вг', m: ['b'] }], 1, 3, (st) => ({
      ...st,
      color: '#c026d3',
    }))
    expect(out).toEqual([
      { t: 'а' },
      { t: 'б', color: '#c026d3' },
      { t: 'в', m: ['b'], color: '#c026d3' },
      { t: 'г', m: ['b'] },
    ])
  })

  it('пустое выделение ничего не меняет', () => {
    expect(restyle(src, 2, 2, (st) => ({ ...st, m: ['b'] }))).toBe(src)
  })

  it('снятие марки возвращает документ к исходному канону', () => {
    const on = toggleMark(src, 1, 3, 'b')
    expect(toggleMark(on, 1, 3, 'b')).toEqual(src)
  })
})

describe('переключатель марки', () => {
  it('частично размеченное выделение доводится до размеченного целиком', () => {
    const partial = toggleMark([{ t: 'абвг' }], 0, 2, 'b')
    expect(hasMarkThroughout(partial, 0, 4, 'b')).toBe(false)
    const all = toggleMark(partial, 0, 4, 'b')
    expect(hasMarkThroughout(all, 0, 4, 'b')).toBe(true)
    expect(all).toEqual([{ t: 'абвг', m: ['b'] }])
  })
})

// Досев марок пустой строки (2026-08-15): жирность заголовков и подписей лежит в
// документе маркой `b`, поэтому первый символ в пустом заголовке обязан родиться с ней.
describe('марки пустой строки', () => {
  it('кусок без марок получает досеянную', () => {
    expect(applyDefaultMarks([{ t: 'Имя' }], ['b'])).toEqual([{ t: 'Имя', m: ['b'] }])
  })

  it('чужие марки сохраняются, своя не дублируется', () => {
    expect(
      applyDefaultMarks(
        [
          { t: 'а', m: ['i'] },
          { t: 'б', m: ['b'] },
        ],
        ['b'],
      ),
    ).toEqual([
      { t: 'а', m: ['i', 'b'] },
      { t: 'б', m: ['b'] },
    ])
  })

  it('пустой набор не трогает текст вовсе — строка абзаца остаётся как есть', () => {
    const spans: Span[] = [{ t: 'Абзац' }]
    expect(applyDefaultMarks(spans, [])).toBe(spans)
  })
})

// Чип подстановки (docs/design/mentions.md §7) — кусок текста с полем ref, и всё
// отличие от обычного куска в одном: он НЕДЕЛИМ. Здесь проверяется ровно это — каждая
// операция модели либо накрывает его целиком, либо не трогает вовсе.
describe('чип подстановки неделим', () => {
  const chip: Span = { t: 'Имя', ref: 'q1' }

  it('канон не склеивает два чипа, даже если источник у них один', () => {
    expect(normalize([chip, { ...chip }])).toEqual([chip, { ...chip }])
  })

  it('канон не приклеивает к чипу соседний текст', () => {
    expect(normalize([{ t: 'Здравствуйте, ' }, chip, { t: '!' }])).toHaveLength(3)
  })

  it('форматирование накрывает чип целиком, а не режет пополам', () => {
    // Выделение с середины имени: у обычного куска здесь был бы разрез на три.
    const out = toggleMark([chip], 1, 2, 'b')
    expect(out).toEqual([{ t: 'Имя', ref: 'q1', m: ['b'] }])
  })

  it('форматирование строки с чипом сохраняет ссылку', () => {
    const out = toggleMark([{ t: 'Привет, ' }, chip], 0, 11, 'b')
    expect(out).toEqual([
      { t: 'Привет, ', m: ['b'] },
      { t: 'Имя', ref: 'q1', m: ['b'] },
    ])
  })

  it('вырезание уносит задетый чип целиком', () => {
    const out = cutRange([{ t: 'а' }, chip, { t: 'б' }], 1, 2)
    expect(out).toEqual([{ t: 'аб' }])
  })
})

// Перенос строки (Shift+Enter) — единственный потребитель `insertText`: всё остальное
// автор печатает в саму поверхность, и модель приезжает разбором DOM.
describe('вставка текста в модель', () => {
  it('в середину куска — оформление куска продолжается, спан остаётся один', () => {
    expect(insertText([{ t: 'абвг', m: ['b'] }], 2, '\n')).toEqual([{ t: 'аб\nвг', m: ['b'] }])
  })

  it('на стыке кусков достаётся ЛЕВОМУ — там, где стоит каретка', () => {
    expect(insertText([{ t: 'аб', m: ['b'] }, { t: 'вг' }], 2, '\n')).toEqual([
      { t: 'аб\n', m: ['b'] },
      { t: 'вг' },
    ])
  })

  it('в конец строки и в пустую строку', () => {
    expect(insertText([{ t: 'аб' }], 2, '\n')).toEqual([{ t: 'аб\n' }])
    expect(insertText([], 0, '\n')).toEqual([{ t: '\n' }])
  })

  it('чип не разрезает: у его начала — перед ним, иначе за ним', () => {
    const chip: Span[] = [{ t: 'Имя', ref: 'q1' }, { t: ' хвост' }]
    expect(insertText(chip, 0, '\n')).toEqual([
      { t: '\n' },
      { t: 'Имя', ref: 'q1' },
      { t: ' хвост' },
    ])
    expect(insertText(chip, 2, '\n')).toEqual([{ t: 'Имя', ref: 'q1' }, { t: '\n хвост' }])
  })

  it('пустая вставка модель не трогает', () => {
    const spans: Span[] = [{ t: 'аб' }]
    expect(insertText(spans, 1, '')).toBe(spans)
  })
})

describe('вставка чипа', () => {
  it('в середину куска — с разрезом и сохранением оформления вокруг', () => {
    const out = insertMention([{ t: 'абвг', m: ['b'] }], 2, 'Имя', 'q1')
    expect(out).toEqual([
      { t: 'аб', m: ['b'] },
      { t: 'Имя', ref: 'q1' },
      { t: ' ' },
      { t: 'вг', m: ['b'] },
    ])
  })

  it('на стыке кусков не плодит пустых половинок', () => {
    const out = insertMention([{ t: 'аб' }, { t: 'вг', m: ['b'] }], 2, 'Имя', 'q1')
    expect(out).toEqual([{ t: 'аб' }, { t: 'Имя', ref: 'q1' }, { t: ' ' }, { t: 'вг', m: ['b'] }])
  })

  it('в конец строки и в пустую строку', () => {
    expect(insertMention([{ t: 'аб' }], 2, 'Имя', 'q1')).toEqual([
      { t: 'аб' },
      { t: 'Имя', ref: 'q1' },
      { t: ' ' },
    ])
    expect(insertMention([], 0, 'Имя', 'q1')).toEqual([{ t: 'Имя', ref: 'q1' }, { t: ' ' }])
  })

  // Пробел за чипом — отдельным куском, а не внутри `t`: в имени вопроса он уехал бы в
  // заголовок колонки CSV и стал бы неудаляемым (чип неделим).
  it('пробел ставится за чипом, но не дублирует уже стоящий', () => {
    const out = insertMention([{ t: 'а ещё' }], 1, 'Имя', 'q1')
    expect(out).toEqual([{ t: 'а' }, { t: 'Имя', ref: 'q1' }, { t: ' ещё' }])
  })

  it('оформление соседа на сам чип не переносится', () => {
    const out = insertMention([{ t: 'абвг', color: '#c026d3' }], 2, 'Имя', 'q1')
    expect(out[1]).toEqual({ t: 'Имя', ref: 'q1' })
  })
})

describe('DOM ↔ модель', () => {
  it('круговой перевод сохраняет модель', () => {
    const spans: Span[] = [{ t: 'а' }, { t: 'бв', m: ['b'] }, { t: 'г', color: '#c026d3' }]
    const el = div()
    spansToDom(el, spans)
    expect(spansFromDom(el)).toEqual(spans)
  })

  it('кусок без стиля печатается голым текстовым узлом, а не пустым span', () => {
    const el = div()
    spansToDom(el, [{ t: 'просто' }])
    expect(el.childNodes).toHaveLength(1)
    expect(el.childNodes[0]!.nodeType).toBe(3)
  })

  it('чип печатается неделимым узлом и читается обратно', () => {
    const el = div()
    const spans: Span[] = [{ t: 'Привет, ' }, { t: 'Имя', ref: 'q1' }, { t: '!' }]
    spansToDom(el, spans)
    const chip = el.querySelector('[data-ref]') as HTMLElement
    expect(chip.dataset.ref).toBe('q1')
    expect(chip.contentEditable).toBe('false')
    expect(spansFromDom(el)).toEqual(spans)
  })

  it('ref НЕ наследуется вглубь, в отличие от оформления', () => {
    // Браузер, набирая на границе, клонирует узел вместе с атрибутами. Унаследуйся
    // ref — и набранное внутри чипа стало бы второй подстановкой того же вопроса.
    const el = div()
    const chip = document.createElement('span')
    chip.dataset.ref = 'q1'
    chip.appendChild(document.createTextNode('Имя'))
    const inner = document.createElement('span')
    inner.className = 'rf-b'
    inner.appendChild(document.createTextNode('хвост'))
    chip.appendChild(inner)
    el.appendChild(chip)
    expect(spansFromDom(el)).toEqual([
      { t: 'Имя', ref: 'q1' },
      { t: 'хвост', m: ['b'] },
    ])
  })

  it('вложенные span (браузер набирает на границе) читаются плоско', () => {
    // Собирается узлами, а не innerHTML: присваивание innerHTML запрещено во всём
    // репозитории (инвариант 4), и правило линтера не делает исключения для тестов.
    const el = div()
    const bold = document.createElement('span')
    bold.className = 'rf-b'
    bold.appendChild(document.createTextNode('жир'))
    const painted = document.createElement('span')
    painted.dataset.color = '#c026d3'
    painted.appendChild(document.createTextNode('ный'))
    bold.appendChild(painted)
    el.appendChild(bold)
    expect(spansFromDom(el)).toEqual([
      { t: 'жир', m: ['b'] },
      { t: 'ный', m: ['b'], color: '#c026d3' },
    ])
  })

  // Регресс на промах, найденный в браузере: жирный не имел вида, потому что кусок не
  // нёс ничего, за что CSS мог бы зацепиться. Утверждение «выглядит жирным» юнит-тест
  // сделать не может (лэйаута у happy-dom нет), а вот «несёт класс, которому дан вид» —
  // может, и этого достаточно, чтобы правило нельзя было потерять молча.
  it('жирный кусок несёт класс, которому CSS даёт вид', () => {
    const el = div()
    spansToDom(el, [{ t: 'жир', m: ['b'] }])
    expect(el.querySelector('span')!.classList.contains(markClass('b'))).toBe(true)
  })

  it('цвет переживает нормализацию style.color браузером', () => {
    const el = div()
    spansToDom(el, [{ t: 'а', color: '#c026d3' }])
    // Браузер при чтении style.color отдаёт «rgb(192, 38, 211)» — воспроизводим это,
    // перезаписав инлайн-стиль. Модель обязана остаться в форме #rrggbb: иначе цвет
    // приезжал бы в схему тем, что валидатор фазы отвергнет.
    el.querySelector('span')!.style.color = 'rgb(192, 38, 211)'
    expect(spansFromDom(el)).toEqual([{ t: 'а', color: '#c026d3' }])
  })

  // Строка многострочная с 2026-08-22: <br>, который принёс браузер, — перенос, а не
  // пробел. Сам редактор <br> не создаёт (перенос вставляет insertText символом).
  it('<br> ПОСРЕДИ текста становится переносом', () => {
    const el = div()
    el.appendChild(document.createTextNode('а'))
    el.appendChild(document.createElement('br'))
    el.appendChild(document.createTextNode('б'))
    expect(plainText(spansFromDom(el))).toBe('а\nб')
  })

  // Дефект, из-за которого строку было НЕ ОПУСТОШИТЬ: стерев последний символ, автор
  // получал обратно пробел. Хвостовой <br> вставляет сам браузер (иначе пустой
  // contenteditable схлопывается по высоте) — это служебный узел, а не перенос.
  it('хвостовой <br> из опустевшей строки не даёт ни пробела, ни спана', () => {
    const el = div()
    el.appendChild(document.createElement('br'))
    expect(spansFromDom(el)).toEqual([])
  })

  it('хвостовой <br> после текста текст не удлиняет', () => {
    const el = div()
    el.appendChild(document.createTextNode('а'))
    el.appendChild(document.createElement('br'))
    expect(spansFromDom(el)).toEqual([{ t: 'а' }])
  })

  // Перенос наследует стиль своего места, иначе он не склеится с соседями и один
  // жирный кусок поедет тремя.
  it('перенос между двумя жирными кусками склеивается в один спан', () => {
    const el = div()
    const mk = (t: string) => {
      const s = document.createElement('span')
      s.className = 'rf-b'
      s.textContent = t
      return s
    }
    const wrap = document.createElement('span')
    wrap.className = 'rf-b'
    wrap.appendChild(mk('а'))
    wrap.appendChild(document.createElement('br'))
    wrap.appendChild(mk('б'))
    el.appendChild(wrap)
    expect(spansFromDom(el)).toEqual([{ t: 'а\nб', m: ['b'] }])
  })
})

// То, что панель форматирования спрашивает у поверхности на каждом кадре протяжки
// мышью. Читается прямо из DOM: собирать ради двух ответов модель — обход дерева, канон
// и N выброшенных объектов на каждое движение.
describe('что стоит на всём выделении', () => {
  // Документ: «аб» жирный, «вг» жирный со ссылкой, «де» без всего.
  const surface = () => {
    const el = div()
    spansToDom(el, [
      { t: 'аб', m: ['b'] },
      { t: 'вг', m: ['b'], href: 'https://a.ru' },
      { t: 'де' },
    ])
    return el
  }

  it('марка на всех кусках диапазона — активна; хоть на одном нет — нет', () => {
    expect([...activeStyle(surface(), 0, 4).marks]).toEqual(['b'])
    expect([...activeStyle(surface(), 0, 5).marks]).toEqual([])
  })

  it('адрес отдаётся, только если он один на весь диапазон', () => {
    expect(activeStyle(surface(), 2, 4).href).toBe('https://a.ru')
    // Накрыли кусок со ссылкой и кусок без неё — «текущего адреса» не существует, и
    // подставлять первый попавшийся в поле правки значило бы тихо переписать соседний.
    expect(activeStyle(surface(), 0, 4).href).toBeUndefined()
  })

  it('кусок, лишь примыкающий к границе, в выделение не входит', () => {
    // [4,6) — это «де» целиком; «вг» слева только касается границы.
    expect(activeStyle(surface(), 4, 6).href).toBeUndefined()
    expect([...activeStyle(surface(), 4, 6).marks]).toEqual([])
  })

  it('диапазон, не накрывший ни одного куска, не активирует ничего', () => {
    expect([...activeStyle(surface(), 9, 12).marks]).toEqual([])
    expect(activeStyle(div(), 0, 3).href).toBeUndefined()
  })

  it('ответ совпадает с тем, что даёт модель', () => {
    const el = surface()
    const spans = spansFromDom(el)
    for (const [from, to] of [
      [0, 2],
      [0, 4],
      [1, 5],
      [2, 6],
    ] as const) {
      const viaDom = [...activeStyle(el, from, to).marks].sort()
      const viaModel = (['b', 'i', 'u', 's'] as const).filter((m) =>
        hasMarkThroughout(spans, from, to, m),
      )
      expect(viaDom).toEqual([...viaModel].sort())
    }
  })
})

describe('каретка в координатах плоского текста', () => {
  it('смещение считается через границы спанов', () => {
    const el = div()
    spansToDom(el, [{ t: 'аб' }, { t: 'вг', m: ['b'] }])
    const bold = el.querySelector('span')!.firstChild!
    expect(caretOffset(el, bold, 1)).toBe(3)
  })

  it('pointAt — обратный перевод, круговой на каждой позиции', () => {
    const el = div()
    spansToDom(el, [{ t: 'аб' }, { t: 'вг', m: ['b'] }])
    for (let i = 0; i <= 4; i++) {
      const p = pointAt(el, i)
      expect(caretOffset(el, p.node, p.offset)).toBe(i)
    }
  })

  it('смещение за пределами текста садится на конец, а не роняет', () => {
    const el = div()
    spansToDom(el, [{ t: 'аб' }])
    const p = pointAt(el, 99)
    expect(caretOffset(el, p.node, p.offset)).toBe(2)
  })
})

describe('цвет как марка со значением', () => {
  it('ставится и снимается тем же restyle, что и булева марка', () => {
    const painted = setColor([{ t: 'абв' }], 0, 3, '#c026d3')
    expect(painted).toEqual([{ t: 'абв', color: '#c026d3' }])
    expect(setColor(painted, 0, 3, undefined)).toEqual([{ t: 'абв' }])
  })
})
