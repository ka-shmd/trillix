import { describe, expect, it } from 'vitest'
import {
  formSchemaSchema,
  isValidPhone,
  MAX_ALT_LEN,
  MAX_BLOCKS,
  MAX_IMAGE_KEY_LEN,
  MAX_OPTIONS,
  MAX_PLACEHOLDER_LEN,
  MAX_REDIRECT_URL_LEN,
  MAX_SUBMIT_LABEL_LEN,
  MAX_TEXT_LEN,
  MAX_THANK_YOU_TEXT_LEN,
} from '@entities/formSchema'

// Зеркало internal/domain/schema_test.go (модель v2, фаза 8.7): вопрос — группа
// блоков (подпись + поле). Zod строгий v2 (апгрейд v1→v2 живёт только на бэке,
// domain.ValidateSchema), поэтому фикстуры — уже v2 (groupId, text, без label/
// description). Схема общая с рендерером; тест гоняет vitest кабинета (web/app).

describe('formSchemaSchema — валидные', () => {
  const valid: Record<string, unknown> = {
    'пустой каркас без schemaVersion': { blocks: [] },
    'все отвечаемые типы (голые поля, свои группы)': {
      schemaVersion: 2,
      blocks: [
        { id: 'b1', groupId: 'g1', type: 'short_text', required: true, settings: {} },
        { id: 'b2', groupId: 'g2', type: 'long_text', settings: {} },
        { id: 'b3', groupId: 'g3', type: 'email', settings: {} },
        { id: 'b4', groupId: 'g4', type: 'number', settings: {} },
        { id: 'b8', groupId: 'g8', type: 'phone', settings: {} },
        { id: 'b9', groupId: 'g9', type: 'scale', settings: { scaleMin: 1, scaleMax: 5 } },
        { id: 'b10', groupId: 'g10', type: 'dropdown', settings: { options: [{ id: 'o1', label: 'Мск' }] } },
        { id: 'b5', groupId: 'g5', type: 'date', settings: {} },
        {
          id: 'b6',
          groupId: 'g6',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Друзья' }, { id: 'o2', label: 'Поиск' }] },
        },
        { id: 'b7', groupId: 'g7', type: 'multi_choice', settings: { options: [{ id: 'o1', label: 'Go' }] } },
      ],
    },
    'вопрос как группа title + поле': {
      schemaVersion: 2,
      blocks: [
        { id: 't1', groupId: 'g1', type: 'title', text: 'Ваше имя' },
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    },
    'контент между подписью и полем': {
      schemaVersion: 2,
      blocks: [
        { id: 'l1', groupId: 'g1', type: 'label', text: 'Логотип' },
        { id: 'im', groupId: 'g1', type: 'image', settings: { imageKey: 'ws/x.png', alt: 'пример' } },
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    },
    'секционный heading своей группой': {
      schemaVersion: 2,
      blocks: [
        { id: 'h1', groupId: 'g1', type: 'heading', text: 'О компании' },
        { id: 'b1', groupId: 'g2', type: 'short_text', settings: {} },
      ],
    },
    'consent несёт собственный текст': {
      schemaVersion: 2,
      blocks: [{ id: 'c', groupId: 'g1', type: 'consent', text: 'Согласен на обработку данных', required: true }],
    },
    'картинка без ключа — черновик': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'image', settings: {} }],
    },
    'шкала NPS 0–10 — ноль законный минимум': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'scale', settings: { scaleMin: 0, scaleMax: 10 } }],
    },
    'шкала без диапазона — валидный черновик': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'scale', settings: {} }],
    },
    'choice без опций — валидный черновик': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'single_choice', settings: {} }],
    },
    'плейсхолдер у текстового поля': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { placeholder: 'Иван' } }],
    },
    'минимальный блок без settings/required': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text' }],
    },
    'submitLabel задан': { blocks: [], submitLabel: 'Готово' },
    'thankYouText задан': { blocks: [], thankYouText: 'Ждём вас на встрече!' },
    'redirectUrl https': { blocks: [], redirectUrl: 'https://example.com/thanks' },
    'redirectUrl http с портом и query': { blocks: [], redirectUrl: 'http://example.com:8080/ok?from=form' },
  }

  for (const [name, doc] of Object.entries(valid)) {
    it(name, () => {
      expect(formSchemaSchema.safeParse(doc).success).toBe(true)
    })
  }
})

// Зеркало TestValidPhone в Go: проверка мягкая — символы и число цифр.
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
    'неизвестная schemaVersion': { schemaVersion: 99, blocks: [] },
    'v1-форма (label/description) — контракт строго v2': {
      blocks: [{ id: 'b', type: 'short_text', label: 'x' }],
    },
    'text у отвечаемого не-consent': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', text: 'нельзя', settings: {} }],
    },
    'text у image': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'image', text: 'нельзя', settings: {} }],
    },
    'пустой groupId': {
      blocks: [{ id: 'b', groupId: '', type: 'short_text', settings: {} }],
    },
    'группа разорвана чужим блоком': {
      blocks: [
        { id: 'a', groupId: 'g1', type: 'title', text: 'A' },
        { id: 'b', groupId: 'g2', type: 'short_text', settings: {} },
        { id: 'c', groupId: 'g1', type: 'email', settings: {} },
      ],
    },
    'два отвечаемых в одной группе': {
      blocks: [
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 'b2', groupId: 'g1', type: 'email', settings: {} },
      ],
    },
    'лишнее поле верхнего уровня': { blocks: [], extra: 1 },
    'лишнее поле блока': { blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', foo: 1 }] },
    'лишнее поле в settings': { blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { foo: 1 } }] },
    'неизвестный тип блока': { blocks: [{ id: 'b', groupId: 'g1', type: 'slider' }] },
    'пустой id блока': { blocks: [{ id: '', groupId: 'g1', type: 'short_text' }] },
    'дубль id блоков': {
      blocks: [
        { id: 'b', groupId: 'g1', type: 'short_text' },
        { id: 'b', groupId: 'g2', type: 'email' },
      ],
    },
    'non-choice с опциями': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { options: [{ id: 'o', label: 'z' }] } }],
    },
    'imageKey на не-image': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { imageKey: 'ws/x.png' } }],
    },
    'alt на не-image': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'heading', text: 'x', settings: { alt: 'y' } }],
    },
    'image с опциями': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'image', settings: { options: [{ id: 'o', label: 'z' }] } }],
    },
    'слишком длинный imageKey': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'image', settings: { imageKey: 'a'.repeat(MAX_IMAGE_KEY_LEN + 1) } }],
    },
    'слишком длинный alt': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'image', settings: { alt: 'я'.repeat(MAX_ALT_LEN + 1) } }],
    },
    'дубль id опций внутри блока': {
      blocks: [
        {
          id: 'b',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o', label: 'a' }, { id: 'o', label: 'b' }] },
        },
      ],
    },
    'пустой id опции': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'single_choice', settings: { options: [{ id: '', label: 'a' }] } }],
    },
    'слишком много блоков': {
      blocks: Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => ({
        id: `b${i}`,
        groupId: `g${i}`,
        type: 'short_text',
      })),
    },
    'слишком много опций': {
      blocks: [
        {
          id: 'b',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({ id: `o${i}`, label: 'x' })) },
        },
      ],
    },
    'слишком длинный текст подписи': {
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: 'я'.repeat(MAX_TEXT_LEN + 1) }],
    },
    'слишком длинный submitLabel': { blocks: [], submitLabel: 'я'.repeat(MAX_SUBMIT_LABEL_LEN + 1) },
    'слишком длинный placeholder': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { placeholder: 'я'.repeat(MAX_PLACEHOLDER_LEN + 1) } }],
    },
    'шкала: min больше max': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'scale', settings: { scaleMin: 5, scaleMax: 2 } }],
    },
    'шкала: min равен max': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'scale', settings: { scaleMin: 3, scaleMax: 3 } }],
    },
    'шкала: max выше потолка': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'scale', settings: { scaleMin: 1, scaleMax: 11 } }],
    },
    'шкала у не-scale': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { scaleMin: 1, scaleMax: 5 } }],
    },
    // Инвариант 4: значение уходит в window.location — чужая схема там это XSS.
    'redirect javascript:': { blocks: [], redirectUrl: 'javascript:alert(document.cookie)' },
    'redirect data:': { blocks: [], redirectUrl: 'data:text/html,<script>alert(1)</script>' },
    'redirect относительный путь': { blocks: [], redirectUrl: '/thanks' },
    'слишком длинный thankYouText': { blocks: [], thankYouText: 'я'.repeat(MAX_THANK_YOU_TEXT_LEN + 1) },
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
