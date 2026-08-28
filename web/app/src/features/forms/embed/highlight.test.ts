import { describe, expect, it } from 'vitest'

import { embedCode, frameUrl, openSnippet, type SnippetOptions } from '../embedSnippet'
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
