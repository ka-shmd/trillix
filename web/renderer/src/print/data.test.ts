import { describe, expect, it } from 'vitest'

import { printDataSchema } from './data'

// Контракт данных печатной страницы. Проверяется схема, а не readPrintData: DOM у
// vitest рендерера нет (окружение node), а разбор — это она.

const schema = {
  schemaVersion: 1,
  blocks: [{ id: 'b1', groupId: 'g1', type: 'short_text' }],
}

const valid = {
  submissionId: '018f0000-0000-7000-8000-000000000000',
  formVersion: 3,
  submittedAt: '2026-08-30T11:00:00Z',
  schema,
  answers: { b1: 'Иван' },
  files: { u1: { name: 'резюме.pdf', size: 1024 } },
}

describe('данные печатной страницы', () => {
  it('разбирает документ целиком', () => {
    const parsed = printDataSchema.parse(valid)
    expect(parsed.answers.b1).toBe('Иван')
    expect(parsed.files.u1!.name).toBe('резюме.pdf')
    expect(parsed.schema.blocks).toHaveLength(1)
  })

  it('ответ-список остаётся списком (множественный выбор, файлы)', () => {
    const parsed = printDataSchema.parse({ ...valid, answers: { b1: ['o1', 'o2'] } })
    expect(parsed.answers.b1).toEqual(['o1', 'o2'])
  })

  it('ответов и файлов может не быть вовсе — пустой лист законен', () => {
    const parsed = printDataSchema.parse({ ...valid, answers: undefined, files: undefined })
    expect(parsed.answers).toEqual({})
    expect(parsed.files).toEqual({})
  })

  it('битая схема формы отвергается целиком: печатать нечего', () => {
    const bad = { ...valid, schema: { schemaVersion: 1, blocks: [{ id: 'b1' }] } }
    expect(printDataSchema.safeParse(bad).success).toBe(false)
  })

  it('число вместо ответа отвергается — в базе ответы строки', () => {
    const bad = { ...valid, answers: { b1: 7 } }
    expect(printDataSchema.safeParse(bad).success).toBe(false)
  })
})
