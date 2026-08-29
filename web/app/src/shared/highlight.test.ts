import { describe, expect, it } from 'vitest'

import {
  embedCode,
  frameUrl,
  openSnippet,
  type SnippetOptions,
} from '../features/forms/embedSnippet'
import { highlight, type Token, type TokenKind } from './highlight'

const base: SnippetOptions = {
  baseUrl: 'https://f.trillix.ru',
  slug: 'opros',
  mode: 'block',
  title: 'Опрос про доставку',
}

const kinds = (code: string, kind: TokenKind) =>
  highlight(code)
    .filter((t) => t.kind === kind)
    .map((t) => t.text)

// СКЛЕЕННЫЕ ТОКЕНЫ ОБЯЗАНЫ ДАВАТЬ ИСХОДНУЮ СТРОКУ. Это главное свойство разбора:
// потерянный символ на экране незаметен (кто сверяет сниппет посимвольно?), а
// скопированный код после него не работает. Сторож любой будущей правки регулярок.
const joined = (tokens: Token[]) => tokens.map((t) => t.text).join('')

describe('highlight: сниппет вставки', () => {
  const code = embedCode(base)

  it('не теряет и не задваивает ни одного символа', () => {
    expect(joined(highlight(code))).toBe(code)
  })

  it('красит теги, имена атрибутов и значения в кавычках', () => {
    expect(kinds(code, 'tag')).toEqual(['<iframe', '</iframe', '<script', '</script'])
    expect(kinds(code, 'attr')).toContain('data-trillix-src')
    expect(kinds(code, 'attr')).toContain('loading')
    expect(kinds(code, 'string')).toContain('"https://f.trillix.ru/r/opros?embed=block"')
  })

  // У `async` значения нет вовсе — правило ловит слово перед пробелом, а не только
  // перед знаком равенства.
  it('красит атрибут без значения', () => {
    expect(kinds(embedCode(base), 'attr')).toContain('async')
  })

  // Внутри значения живут `=` и `&`, и разбирать их как атрибуты нельзя: строковое
  // правило съедает значение целиком раньше, чем до них дойдёт очередь.
  it('параметры адреса внутри значения не становятся атрибутами', () => {
    const withParams = embedCode({ ...base, hideTitle: true, alignLeft: true })
    expect(kinds(withParams, 'attr')).not.toContain('hideTitle')
    expect(kinds(withParams, 'string').join('')).toContain('hideTitle=1')
  })

  // Кавычку внутрь значения не пропускает escapeAttr — на этом стоит простое
  // правило `"[^"]*"`. Название формы с кавычками и есть тот вход, где это важно.
  it('название с кавычками остаётся одним значением', () => {
    const quoted = embedCode({ ...base, title: 'Опрос "Лето"' })
    expect(joined(highlight(quoted))).toBe(quoted)
    expect(kinds(quoted, 'string')).toContain('"Опрос &quot;Лето&quot;"')
  })
})

describe('highlight: вызов из кода', () => {
  const code = openSnippet(base)

  it('не теряет и не задваивает ни одного символа', () => {
    expect(joined(highlight(code))).toBe(code)
  })

  it('красит имя объекта, ключи и строки', () => {
    expect(kinds(code, 'tag')).toEqual(['Trillix'])
    expect(kinds(code, 'attr')).toContain('form')
    expect(kinds(code, 'attr')).toContain('mode')
    expect(kinds(code, 'string')).toContain("'opros'")
  })

  // Правило комментария осталось в грамматике: наш вывод его больше не содержит, но
  // кавычка в чужой строке не должна открывать литерал, если код туда однажды вернут.
  it('кавычка внутри комментария не рвёт разбор', () => {
    const withComment = `${code} // Кавычка 'внутри' подписи`
    expect(joined(highlight(withComment))).toBe(withComment)
    expect(kinds(withComment, 'comment')).toEqual(["// Кавычка 'внутри' подписи"])
    expect(kinds(withComment, 'string')).not.toContain("'внутри'")
  })
})

describe('highlight: адрес', () => {
  it('не размечается — читается одним взглядом и копируется кнопкой', () => {
    const url = frameUrl(base)
    expect(highlight(url)).toEqual([{ text: url, kind: 'plain' }])
  })
})

// CSS АВТОРА ФОРМЫ — четвёртая грамматика и единственная, чей вход мы не печатаем
// сами. Проверяется то же главное свойство (склейка даёт исходную строку) и разбор
// селектора против свойства: он держится на лукахеде и ломается тише всего.
describe('highlight (css)', () => {
  const css = (code: string, kind: TokenKind) =>
    highlight(code, 'css')
      .filter((t) => t.kind === kind)
      .map((t) => t.text)

  it('не теряет и не задваивает символы', () => {
    const code = '/* заметка */\n.my-block .rf-input {\n  border-radius: 0;\n}\n'
    expect(
      highlight(code, 'css')
        .map((t: Token) => t.text)
        .join(''),
    ).toBe(code)
  })

  it('различает селектор и свойство', () => {
    const code = '.my-block .rf-input {\n  border-radius: 0;\n  color: red\n}'
    expect(css(code, 'tag')).toEqual(['.my-block', '.rf-input'])
    // Свойство внутри блока селектором не притворяется: лукахед упирается в `;` или
    // `}` раньше, чем в открывающую скобку. Последнее объявление без `;` — тоже.
    expect(css(code, 'attr')).toEqual(['border-radius', 'color'])
  })

  it('берёт комментарий целиком, включая переносы', () => {
    expect(css('/* две\nстроки */\n.a { color: red }', 'comment')).toEqual(['/* две\nстроки */'])
  })

  it('видит строку в значении', () => {
    expect(css('.a::after { content: "×" }', 'string')).toEqual(['"×"'])
  })

  it('id и элемент — тоже селекторы', () => {
    expect(css('#top {}\ninput { color: red }', 'tag')).toEqual(['#top', 'input'])
  })
})
