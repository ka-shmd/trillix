import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toggleMulti } from '@fields/answer'

import {
  answersReducer,
  clearAnswers,
  loadAnswers,
  loadPage,
  loadSubmissionId,
  savePage,
  saveSubmissionId,
  saveAnswers,
  type Answers,
} from './answers'

// Минимальный sessionStorage для node-окружения теста (jsdom не подключаем —
// зависимостей рендерера не трогаем).
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v)
  }
  removeItem(k: string): void {
    this.m.delete(k)
  }
  clear(): void {
    this.m.clear()
  }
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', new MemStorage())
})

describe('answersReducer', () => {
  it('set кладёт и перезаписывает ответ по blockId', () => {
    let s: Answers = {}
    s = answersReducer(s, { type: 'set', blockId: 'b1', value: 'привет' })
    s = answersReducer(s, { type: 'set', blockId: 'b2', value: ['o1', 'o2'] })
    s = answersReducer(s, { type: 'set', blockId: 'b1', value: 'пока' })
    expect(s).toEqual({ b1: 'пока', b2: ['o1', 'o2'] })
  })
  it('не мутирует прежнее состояние', () => {
    const prev: Answers = { b1: 'x' }
    const next = answersReducer(prev, { type: 'set', blockId: 'b2', value: 'y' })
    expect(prev).toEqual({ b1: 'x' })
    expect(next).not.toBe(prev)
  })
})

describe('sessionStorage черновика', () => {
  it('save → load возвращает те же ответы', () => {
    const answers: Answers = { b1: 'текст', b2: ['a', 'b'] }
    saveAnswers('slug1', 1, answers)
    expect(loadAnswers('slug1', 1)).toEqual(answers)
  })
  it('версия и slug изолируют черновики', () => {
    saveAnswers('slug1', 1, { b1: 'v1' })
    expect(loadAnswers('slug1', 2)).toEqual({}) // другая версия — пусто
    expect(loadAnswers('slug2', 1)).toEqual({}) // другой slug — пусто
  })
  it('битые данные в хранилище → пустой черновик, без падения', () => {
    sessionStorage.setItem('trillix:answers:slug1:1', '{не json')
    expect(loadAnswers('slug1', 1)).toEqual({})
    sessionStorage.setItem('trillix:answers:slug1:1', '{"b1": 42}') // число — не Answer
    expect(loadAnswers('slug1', 1)).toEqual({})
  })
})

describe('toggleMulti (@fields)', () => {
  it('добавляет при выборе, убирает при снятии', () => {
    expect(toggleMulti([], 'a', true)).toEqual(['a'])
    expect(toggleMulti(['a'], 'b', true)).toEqual(['a', 'b'])
    expect(toggleMulti(['a', 'b'], 'a', false)).toEqual(['b'])
  })
})

// Номер открытой страницы (фаза 19) — тот же контракт, что у черновика ответов:
// переживает F5, привязан к версии, при любом сомнении даёт первую страницу.
describe('loadPage/savePage', () => {
  it('сохранённый шаг возвращается', () => {
    savePage('form', 3, 2)
    expect(loadPage('form', 3, 4)).toBe(2)
  })

  it('шага нет — первая страница', () => {
    expect(loadPage('form', 3, 4)).toBe(0)
  })

  // Форму переопубликовали короче, пока вкладка стояла открытой: сохранённый номер
  // указывает за конец документа, и открыть его значило бы показать пустой экран.
  it('шаг за пределами документа — первая страница', () => {
    savePage('form', 3, 5)
    expect(loadPage('form', 3, 2)).toBe(0)
  })

  it('мусор в хранилище — первая страница, а не падение', () => {
    sessionStorage.setItem('trillix:page:form:3', 'третья')
    expect(loadPage('form', 3, 4)).toBe(0)
  })

  it('номер версии входит в ключ: шаг чужой версии не читается', () => {
    savePage('form', 3, 1)
    expect(loadPage('form', 4, 4)).toBe(0)
  })

  it('clearAnswers уносит и шаг: F5 на «Спасибо» не воскрешает третью страницу', () => {
    savePage('form', 3, 2)
    clearAnswers('form', 3)
    expect(loadPage('form', 3, 4)).toBe(0)
  })
})

describe('id попытки отправки', () => {
  // РЕГРЕССИЯ (фаза 27). Первая редакция рождала id при каждом монтировании, а
  // черновик переживал F5 вместе с выбранным временем. После перезагрузки человек
  // становился чужим собственной броне: своё время видел занятым, а отправка старого
  // ответа упиралась в «время записи не выбрано».
  it('переживает перезагрузку', () => {
    saveSubmissionId('form', 3, '0192f0a0-1c2d-7e3f-8a4b-5c6d7e8f9012')
    expect(loadSubmissionId('form', 3)).toBe('0192f0a0-1c2d-7e3f-8a4b-5c6d7e8f9012')
  })

  it('мусор в хранилище за id не принимается', () => {
    sessionStorage.setItem('trillix:submission:form:3', 'не-uuid')
    expect(loadSubmissionId('form', 3)).toBeNull()
  })

  it('привязан к версии и форме', () => {
    saveSubmissionId('form', 3, '0192f0a0-1c2d-7e3f-8a4b-5c6d7e8f9012')
    expect(loadSubmissionId('form', 4)).toBeNull()
    expect(loadSubmissionId('form2', 3)).toBeNull()
  })

  // Иначе второй ответ на ту же форму уехал бы под тем же id, и сервер отбросил бы
  // его как повтор (ON CONFLICT DO NOTHING) — молча.
  it('чистится вместе с черновиком после отправки', () => {
    saveSubmissionId('form', 3, '0192f0a0-1c2d-7e3f-8a4b-5c6d7e8f9012')
    clearAnswers('form', 3)
    expect(loadSubmissionId('form', 3)).toBeNull()
  })
})
