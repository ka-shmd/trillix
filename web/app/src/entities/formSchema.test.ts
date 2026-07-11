import { describe, expect, it } from 'vitest'
import {
  formSchemaSchema,
  MAX_BLOCKS,
  MAX_LABEL_LEN,
  MAX_OPTIONS,
} from '@entities/formSchema'

// Зеркало internal/domain/schema_test.go: те же валидные/невалидные кейсы, чтобы
// контракт двух сторон не разъехался. Схема живёт в web/shared/entities и общая
// с рендерером; тест гоняет vitest кабинета (web/app).

describe('formSchemaSchema — валидные', () => {
  const valid: Record<string, unknown> = {
    'пустой каркас без schemaVersion': { blocks: [] },
    'все семь типов': {
      schemaVersion: 1,
      blocks: [
        { id: 'blk_1', type: 'short_text', label: 'Имя', description: '', required: true, settings: {} },
        { id: 'blk_2', type: 'long_text', label: 'О себе', required: false, settings: {} },
        { id: 'blk_3', type: 'email', label: 'Почта', required: true, settings: {} },
        { id: 'blk_4', type: 'number', label: 'Возраст', required: false, settings: {} },
        { id: 'blk_5', type: 'date', label: 'Дата', required: false, settings: {} },
        {
          id: 'blk_6',
          type: 'single_choice',
          label: 'Откуда',
          required: false,
          settings: { options: [{ id: 'o1', label: 'Друзья' }, { id: 'o2', label: 'Поиск' }] },
        },
        { id: 'blk_7', type: 'multi_choice', label: 'Языки', settings: { options: [{ id: 'o1', label: 'Go' }] } },
      ],
    },
    'choice без опций — валидный черновик': {
      blocks: [{ id: 'b', type: 'single_choice', label: '', settings: {} }],
    },
    'пустой label — валидный черновик': {
      blocks: [{ id: 'b', type: 'short_text', label: '' }],
    },
    'минимальный блок без settings/required/description': {
      blocks: [{ id: 'b', type: 'short_text', label: 'x' }],
    },
  }

  for (const [name, doc] of Object.entries(valid)) {
    it(name, () => {
      expect(formSchemaSchema.safeParse(doc).success).toBe(true)
    })
  }
})

describe('formSchemaSchema — невалидные', () => {
  const invalid: Record<string, unknown> = {
    'неизвестная schemaVersion': { schemaVersion: 2, blocks: [] },
    'лишнее поле верхнего уровня': { blocks: [], extra: 1 },
    'лишнее поле блока': { blocks: [{ id: 'b', type: 'short_text', label: 'x', foo: 1 }] },
    'лишнее поле в settings': { blocks: [{ id: 'b', type: 'short_text', label: 'x', settings: { foo: 1 } }] },
    'неизвестный тип блока': { blocks: [{ id: 'b', type: 'slider', label: 'x' }] },
    'пустой id блока': { blocks: [{ id: '', type: 'short_text', label: 'x' }] },
    'дубль id блоков': {
      blocks: [
        { id: 'b', type: 'short_text', label: 'x' },
        { id: 'b', type: 'email', label: 'y' },
      ],
    },
    'non-choice с опциями': {
      blocks: [{ id: 'b', type: 'short_text', label: 'x', settings: { options: [{ id: 'o', label: 'z' }] } }],
    },
    'дубль id опций внутри блока': {
      blocks: [
        {
          id: 'b',
          type: 'single_choice',
          label: 'x',
          settings: { options: [{ id: 'o', label: 'a' }, { id: 'o', label: 'b' }] },
        },
      ],
    },
    'пустой id опции': {
      blocks: [{ id: 'b', type: 'single_choice', label: 'x', settings: { options: [{ id: '', label: 'a' }] } }],
    },
    'слишком много блоков': {
      blocks: Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => ({
        id: `b${i}`,
        type: 'short_text',
        label: 'x',
      })),
    },
    'слишком много опций': {
      blocks: [
        {
          id: 'b',
          type: 'single_choice',
          label: 'x',
          settings: {
            options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({ id: `o${i}`, label: 'x' })),
          },
        },
      ],
    },
    'слишком длинный label': {
      blocks: [{ id: 'b', type: 'short_text', label: 'я'.repeat(MAX_LABEL_LEN + 1) }],
    },
  }

  for (const [name, doc] of Object.entries(invalid)) {
    it(name, () => {
      expect(formSchemaSchema.safeParse(doc).success).toBe(false)
    })
  }
})
