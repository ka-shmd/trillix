// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { plainText, type Span } from '@entities/formSchema'
import {
  caretOffset,
  hasMarkThroughout,
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

  it('<br> ПОСРЕДИ текста становится пробелом — строка полотна однострочная', () => {
    const el = div()
    el.appendChild(document.createTextNode('а'))
    el.appendChild(document.createElement('br'))
    el.appendChild(document.createTextNode('б'))
    expect(plainText(spansFromDom(el))).toBe('а б')
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

  // Пробел на месте переноса наследует стиль своего места, иначе он не склеится с
  // соседями и один жирный кусок поедет тремя.
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
    expect(spansFromDom(el)).toEqual([{ t: 'а б', m: ['b'] }])
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
