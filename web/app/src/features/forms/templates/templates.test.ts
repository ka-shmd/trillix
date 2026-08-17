import { describe, expect, it } from 'vitest'

import { formSchemaSchema } from '@entities/formSchema'
import { TEMPLATES, buildTemplateSchema, questionCaptions } from './templates'

// Шаблон, разошедшийся со схемой формы, должен ловиться здесь, а не автором, который
// уже нажал «Использовать»: у галереи нет ни валидатора на входе, ни ручки, которая
// вернула бы 422 до создания формы, — PATCH черновика отвергнет документ уже ПОСЛЕ
// того, как форма заведена.

describe('встроенные шаблоны', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('«%s» — валидный документ формы', (_, t) => {
    const parsed = formSchemaSchema.safeParse(buildTemplateSchema(t))
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(parsed.success).toBe(true)
  })

  it.each(TEMPLATES.map((t) => [t.id, t] as const))('«%s» спрашивает хоть о чём-то', (_, t) => {
    expect(questionCaptions(t).length).toBeGreaterThan(2)
    expect(t.title.trim()).not.toBe('')
    expect(t.description.trim()).not.toBe('')
  })

  it('id шаблонов уникальны — по ним ключуются карточки и кнопка «Создаём…»', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length)
  })

  it('две формы из одного шаблона не делят id блоков', () => {
    const a = buildTemplateSchema(TEMPLATES[0]!).blocks.map((b) => b.id)
    const b = buildTemplateSchema(TEMPLATES[0]!).blocks.map((b) => b.id)

    expect(new Set([...a, ...b]).size).toBe(a.length + b.length)
    // Заодно: внутри одного документа id тоже уникальны.
    expect(new Set(a).size).toBe(a.length)
  })

  it('вопрос шаблона — подпись и поле в ОДНОЙ группе', () => {
    const schema = buildTemplateSchema(TEMPLATES[1]!)
    const groups = new Map<string, string[]>()
    for (const b of schema.blocks) {
      groups.set(b.groupId, [...(groups.get(b.groupId) ?? []), b.type])
    }
    // Пары «подпись + поле» есть, а группы из двух подписей или двух полей — нет.
    expect([...groups.values()].some((types) => types.length === 2)).toBe(true)
    for (const types of groups.values()) {
      expect(types.filter((t) => t === 'title').length).toBeLessThan(2)
    }
  })
})

// Заголовок формы обязан быть первым блоком документа: на этом держатся splitFormTitle
// (все три поверхности) и зеркало forms.title на сервере.
describe('заголовок формы', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('«%s» начинается с form_title', (_, t) => {
    const blocks = buildTemplateSchema(t).blocks
    expect(blocks[0]?.type).toBe('form_title')
    expect(blocks.filter((b) => b.type === 'form_title')).toHaveLength(1)
  })
})
