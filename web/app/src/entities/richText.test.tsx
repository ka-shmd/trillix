// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach } from 'vitest'
import { BlockField, RichText } from '@fields/BlockField'
import { type Block, type Span } from '@entities/formSchema'

// Вывод богатого текста (этап 14.2, §3.1 docs/design/rich-text.md). Проверяется тот
// самый код, который исполняет ПУБЛИЧНЫЙ РЕНДЕРЕР: `RichText` живёт в общем
// `web/shared/fields`, а тест — здесь, потому что DOM-окружение (happy-dom +
// @testing-library) узаконено только в кабинете (web/CLAUDE.md), и у web/shared своего
// vitest нет. Тот же приём, что у groups.test.ts.
//
// Чего этот набор НЕ доказывает: как марка ВЫГЛЯДИТ. Лэйаута у happy-dom нет, правила
// `fields.css` тут не применяются, поэтому «жирный жирный» проверяется только в
// браузере — и один раз уже был потерян именно так (правила .rf-b не существовало,
// нашёл владелец). Здесь утверждается более слабое, но проверяемое: кусок несёт класс,
// которому в fields.css дан вид, и разметка не протекает в текст.

afterEach(cleanup)

const html = (spans: Span[]) => render(<RichText spans={spans} />).container

describe('RichText — булевы марки', () => {
  it('каждая марка даёт свой класс rf-*', () => {
    const c = html([
      { t: 'ж', m: ['b'] },
      { t: 'к', m: ['i'] },
      { t: 'п', m: ['u'] },
      { t: 'з', m: ['s'] },
    ])
    expect(c.querySelector('.rf-b')?.textContent).toBe('ж')
    expect(c.querySelector('.rf-i')?.textContent).toBe('к')
    expect(c.querySelector('.rf-u')?.textContent).toBe('п')
    expect(c.querySelector('.rf-s')?.textContent).toBe('з')
  })

  it('несколько марок на одном куске — все классы на одном span', () => {
    const c = html([{ t: 'всё', m: ['b', 'i', 'u', 's'] }])
    const el = c.querySelector('span')!
    for (const cls of ['rf-b', 'rf-i', 'rf-u', 'rf-s']) {
      expect(el.classList.contains(cls)).toBe(true)
    }
  })

  it('кусок без оформления не оборачивается в span вовсе', () => {
    const c = html([{ t: 'просто текст' }])
    expect(c.querySelector('span')).toBeNull()
    expect(c.textContent).toBe('просто текст')
  })
})

describe('RichText — марки со значением', () => {
  it('цвет и фон уходят в inline-style, а не в класс', () => {
    const c = html([{ t: 'а', color: '#c026d3', bg: '#ffff00' }])
    const el = c.querySelector('span')!
    expect(el.style.color).toBeTruthy()
    expect(el.style.backgroundColor).toBeTruthy()
    // Класса на значимую марку не бывает: значение свободное (ADR §10).
    expect(el.className).toBe('')
  })
})

describe('RichText — ссылки (инвариант 4)', () => {
  it('годная ссылка → <a> с target и rel', () => {
    const c = html([{ t: 'политика', href: 'https://trillix.ru/privacy' }])
    const a = c.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://trillix.ru/privacy')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a.textContent).toBe('политика')
  })

  // Демо-критерий этапа 14.2. Такой href не может попасть в схему через валидатор — но
  // проверка на выводе существует именно потому, что доверять содержимому схемы В
  // ТОЧКЕ ИСПОЛЬЗОВАНИЯ нельзя (то же правило, что у redirectUrl): документ мог
  // приехать из БД, собранной другой версией кода или руками.
  it.each([
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['относительный путь', '/privacy'],
    ['без хоста', 'https://'],
  ])('ссылка %s рисуется ТЕКСТОМ, а не ссылкой', (_name, href) => {
    const c = html([{ t: 'нажми', href }])
    expect(c.querySelector('a')).toBeNull()
    expect(c.textContent).toBe('нажми')
  })

  it('оформление на негодной ссылке сохраняется — теряется только сама ссылка', () => {
    const c = html([{ t: 'нажми', href: 'javascript:1', m: ['b'] }])
    expect(c.querySelector('a')).toBeNull()
    expect(c.querySelector('.rf-b')?.textContent).toBe('нажми')
  })
})

describe('RichText — разметка не протекает в текст', () => {
  it('textContent равен склейке кусков', () => {
    const spans: Span[] = [
      { t: 'Согласен с ' },
      { t: 'политикой', href: 'https://a.ru/p', m: ['u'] },
      { t: ' и ' },
      { t: 'правилами', m: ['b'], color: '#000000' },
    ]
    expect(html(spans).textContent).toBe('Согласен с политикой и правилами')
  })

  it('пустой текст ничего не рисует', () => {
    expect(html([]).textContent).toBe('')
    expect(render(<RichText spans={undefined} />).container.textContent).toBe('')
  })
})

// Сквозь BlockField — то есть ровно так, как блок увидит респондент: подпись, заголовок
// раздела, абзац и текст согласия.
describe('BlockField рисует богатый текст всех текстовых типов', () => {
  const rich: Span[] = [{ t: 'важно', m: ['b'] }, { t: ' и ссылка', href: 'https://a.ru' }]

  it.each([
    ['title', '.rf-label'],
    ['label', '.rf-label--sm'],
    ['heading', '.rf-heading'],
    ['text', '.rf-text'],
  ])('тип %s: марка и ссылка на месте внутри %s', (type, sel) => {
    const block = { id: 'b', groupId: 'g', type, text: rich } as Block
    const c = render(<BlockField block={block} />).container
    const host = c.querySelector(sel)!
    expect(host.querySelector('.rf-b')?.textContent).toBe('важно')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://a.ru')
    expect(host.textContent).toContain('важно и ссылка')
  })

  it('consent: богатый текст рядом с галочкой (ссылка на политику — главный случай)', () => {
    const block = {
      id: 'c',
      groupId: 'g',
      type: 'consent',
      required: true,
      text: [{ t: 'Согласен с ' }, { t: 'политикой', href: 'https://a.ru/p' }],
    } as Block
    const c = render(<BlockField block={block} />).container
    expect(c.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(c.querySelector('.rf-consent a')?.getAttribute('href')).toBe('https://a.ru/p')
  })

  // Превью билдера рисуется тем же кодом, что и живая форма (BlockField, disabled по
  // умолчанию) — и ссылка в нём обязана выглядеть ссылкой, но никуда не вести: клик по
  // ней уводил бы АВТОРА с полотна посреди сборки формы.
  it('в превью ссылка выглядит ссылкой, но клик не уводит; у респондента — уводит', () => {
    const block = { id: 'b', groupId: 'g', type: 'text', text: rich } as Block

    const preview = render(<BlockField block={block} />).container
    const a = preview.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://a.ru')
    expect(fireEvent.click(a)).toBe(false) // дефолт погашен — перехода нет

    cleanup()
    const live = render(<BlockField block={block} disabled={false} />).container
    expect(fireEvent.click(live.querySelector('a')!)).toBe(true)
  })

  it('пустой текст даёт прежний плейсхолдер, а не пустое место', () => {
    const block = { id: 'b', groupId: 'g', type: 'title', text: [] } as Block
    const c = render(<BlockField block={block} />).container
    expect(c.textContent).toContain('Без названия')
  })
})
