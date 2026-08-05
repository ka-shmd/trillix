import { describe, expect, it } from 'vitest'

import { type Block } from '@entities/formSchema'

import { firstErrorPage, firstQuestionIndex, pageOfBlock } from './pages'

const b = (id: string): Block => ({ id, groupId: id, type: 'short_text' })
const content = (id: string): Block => ({ id, groupId: id, type: 'heading' })

// Страницы тут задаются готовыми: разбиение проверяет splitPages (тест в кабинете),
// здесь — только решение «куда вести человека».
const pages: Block[][] = [[b('a1'), b('a2')], [b('b1')], [b('c1')]]

describe('pageOfBlock', () => {
  it('находит страницу блока', () => {
    expect(pageOfBlock(pages, 'a2')).toBe(0)
    expect(pageOfBlock(pages, 'c1')).toBe(2)
  })

  it('блока нет ни на одной странице — -1', () => {
    expect(pageOfBlock(pages, 'нет такого')).toBe(-1)
  })
})

describe('firstErrorPage', () => {
  it('ошибок нет — вести некуда', () => {
    expect(firstErrorPage(pages, {})).toBeNull()
  })

  it('ведёт на самую раннюю страницу с ошибкой, а не на любую', () => {
    expect(firstErrorPage(pages, { c1: 'Обязательное поле', b1: 'Обязательное поле' })).toBe(1)
  })

  it('ошибка на текущей странице тоже возвращается — решение остаётся у вызывающего', () => {
    expect(firstErrorPage(pages, { a1: 'Обязательное поле' })).toBe(0)
  })

  // Форму могли переопубликовать, пока вкладка стояла открытой: сервер пометит поле,
  // которого в открытой версии уже нет. Вести на несуществующую страницу нельзя.
  it('ошибки на исчезнувших блоках игнорируются', () => {
    expect(firstErrorPage(pages, { исчез: 'Обязательное поле' })).toBeNull()
    expect(firstErrorPage(pages, { исчез: 'x', c1: 'Обязательное поле' })).toBe(2)
  })
})

// firstQuestionIndex — «дошёл до страницы N» для воронки: id первого ВОПРОСА новой
// страницы, найденный в позициях полного документа. Позиция, а не порядок внутри
// страницы: дальняя точка визита сравнивается по документу, и вторая мера разошлась бы
// с первой на первом же «Назад».
describe('firstQuestionIndex', () => {
  const doc = [b('a1'), content('h1'), b('a2'), content('h2'), b('c1')]

  it('находит первый вопрос страницы в позициях документа', () => {
    expect(firstQuestionIndex(doc, [content('h2'), doc[4]!])).toBe(4)
  })

  it('неотвечаемые блоки вопросом не считаются', () => {
    expect(firstQuestionIndex(doc, [doc[1]!])).toBe(-1)
  })

  it('пустая страница — вопросов нет', () => {
    expect(firstQuestionIndex(doc, [])).toBe(-1)
  })
})
