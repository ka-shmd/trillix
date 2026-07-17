import { describe, expect, it } from 'vitest'
import {
  formSchemaSchema,
  isValidPhone,
  MAX_ALT_LEN,
  MAX_BLOCKS,
  MAX_IMAGE_KEY_LEN,
  MAX_LABEL_LEN,
  MAX_OPTIONS,
  MAX_PLACEHOLDER_LEN,
  MAX_REDIRECT_URL_LEN,
  MAX_SUBMIT_LABEL_LEN,
  MAX_THANK_YOU_TEXT_LEN,
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
    'неотвечаемый text-блок': {
      blocks: [{ id: 'b', type: 'text', label: 'Раздел А', settings: {} }],
    },
    'картинка с imageKey и alt': {
      blocks: [{ id: 'b', type: 'image', label: '', settings: { imageKey: 'ws/deadbeef.png', alt: 'Схема' } }],
    },
    'картинка без ключа — черновик': {
      blocks: [{ id: 'b', type: 'image', label: '', settings: {} }],
    },
    'submitLabel задан': { blocks: [], submitLabel: 'Готово' },
    'dropdown с опциями — та же модель, что single_choice': {
      blocks: [
        {
          id: 'b',
          type: 'dropdown',
          label: 'Город',
          settings: { options: [{ id: 'o1', label: 'Москва' }] },
        },
      ],
    },
    'dropdown без опций — валидный черновик': {
      blocks: [{ id: 'b', type: 'dropdown', label: '', settings: {} }],
    },
    'телефон с плейсхолдером': {
      blocks: [{ id: 'b', type: 'phone', label: 'Телефон', settings: { placeholder: '+7 900' } }],
    },
    'thankYouText задан': { blocks: [], thankYouText: 'Ждём вас на встрече!' },
    'redirectUrl https': { blocks: [], redirectUrl: 'https://example.com/thanks' },
    'redirectUrl http с портом и query': {
      blocks: [],
      redirectUrl: 'http://example.com:8080/ok?from=form',
    },
    'оба поля экрана заданы': {
      blocks: [],
      thankYouText: 'Спасибо!',
      redirectUrl: 'https://example.com',
    },
    'placeholder у текстового поля': {
      blocks: [{ id: 'b', type: 'short_text', label: 'Имя', settings: { placeholder: 'Иван' } }],
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

// Зеркало TestValidPhone в Go: проверка мягкая — символы и число цифр, не формат
// страны (решение владельца, DEV-PLAN фаза 8.5 шаг 2).
describe('isValidPhone', () => {
  it.each(['+7 900 123-45-67', '+79001234567', '8(900)123-45-67', '+380 44 123 4567', '12345'])(
    'валиден: %s',
    (v) => {
      expect(isValidPhone(v)).toBe(true)
    },
  )

  it.each(['позвоните мне', '1234', '123456789012345678901', '', '+7_900_1234567', 'a@b.co'])(
    'невалиден: %s',
    (v) => {
      expect(isValidPhone(v)).toBe(false)
    },
  )
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
    'imageKey на не-image': {
      blocks: [{ id: 'b', type: 'short_text', label: 'x', settings: { imageKey: 'ws/x.png' } }],
    },
    'alt на не-image': {
      blocks: [{ id: 'b', type: 'text', label: 'x', settings: { alt: 'y' } }],
    },
    'image с опциями': {
      blocks: [{ id: 'b', type: 'image', label: '', settings: { options: [{ id: 'o', label: 'z' }] } }],
    },
    'слишком длинный imageKey': {
      blocks: [{ id: 'b', type: 'image', label: '', settings: { imageKey: 'a'.repeat(MAX_IMAGE_KEY_LEN + 1) } }],
    },
    'слишком длинный alt': {
      blocks: [{ id: 'b', type: 'image', label: '', settings: { alt: 'я'.repeat(MAX_ALT_LEN + 1) } }],
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
    'слишком длинный submitLabel': {
      blocks: [],
      submitLabel: 'я'.repeat(MAX_SUBMIT_LABEL_LEN + 1),
    },
    'слишком длинный placeholder': {
      blocks: [
        {
          id: 'b',
          type: 'short_text',
          label: 'x',
          settings: { placeholder: 'я'.repeat(MAX_PLACEHOLDER_LEN + 1) },
        },
      ],
    },
    // Инвариант 4: значение уходит в window.location — чужая схема там это XSS.
    'redirect javascript:': { blocks: [], redirectUrl: 'javascript:alert(document.cookie)' },
    'redirect JavaScript: капсом': { blocks: [], redirectUrl: 'JavaScript:alert(1)' },
    'redirect data:': { blocks: [], redirectUrl: 'data:text/html,<script>alert(1)</script>' },
    'redirect относительный путь': { blocks: [], redirectUrl: '/thanks' },
    'redirect без схемы': { blocks: [], redirectUrl: 'example.com' },
    'redirect http без хоста': { blocks: [], redirectUrl: 'http://' },
    'слишком длинный thankYouText': {
      blocks: [],
      thankYouText: 'я'.repeat(MAX_THANK_YOU_TEXT_LEN + 1),
    },
    'слишком длинный redirectUrl': {
      blocks: [],
      redirectUrl: `https://example.com/${'a'.repeat(MAX_REDIRECT_URL_LEN)}`,
    },
  }

  for (const [name, doc] of Object.entries(invalid)) {
    it(name, () => {
      expect(formSchemaSchema.safeParse(doc).success).toBe(false)
    })
  }
})
