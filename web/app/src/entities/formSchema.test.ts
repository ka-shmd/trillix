import { describe, expect, it } from 'vitest'
import {
  formSchemaSchema,
  isValidPhone,
  MAX_BLOCKS,
  MAX_FORM_TITLE_LEN,
  MAX_IMAGE_KEY_LEN,
  MAX_OPTIONS,
  MAX_PLACEHOLDER_LEN,
  MAX_REDIRECT_URL_LEN,
  MAX_SUBMIT_LABEL_LEN,
  MAX_SPANS,
  MAX_TEXT_LEN,
  MAX_THANK_YOU_TEXT_LEN,
  plainText,
  sameRichText,
  textFromString,
  SCHEMA_VERSION,
} from '@entities/formSchema'

// Зеркало internal/domain/schema_test.go (модель v2, фаза 8.7): вопрос — группа
// блоков (подпись + поле). Zod строгий v2 (апгрейд v1→v2 живёт только на бэке,
// domain.ValidateSchema), поэтому фикстуры — уже v2 (groupId, text, без label/
// description). Схема общая с рендерером; тест гоняет vitest кабинета (web/app).

describe('formSchemaSchema — валидные', () => {
  const valid: Record<string, unknown> = {
    'пустой каркас без schemaVersion': { blocks: [] },
    'все отвечаемые типы (голые поля, свои группы)': {
      schemaVersion: SCHEMA_VERSION,
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
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 't1', groupId: 'g1', type: 'title', text: [{ t: 'Ваше имя' }] },
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    },
    'контент между подписью и полем': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'l1', groupId: 'g1', type: 'label', text: [{ t: 'Логотип' }] },
        { id: 'im', groupId: 'g1', type: 'image', settings: { imageKey: 'ws/x.png' } },
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    },
    'секционный heading своей группой': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 'h1', groupId: 'g1', type: 'heading', text: [{ t: 'О компании' }] },
        { id: 'b1', groupId: 'g2', type: 'short_text', settings: {} },
      ],
    },
    'consent несёт собственный текст': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [{ id: 'c', groupId: 'g1', type: 'consent', text: [{ t: 'Согласен на обработку данных' }], required: true }],
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
    // Фаза 13.6: бит ряда у whitelist-типов и у вариантов.
    'column right у short_text': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { column: 'right' } }],
    },
    'column right у dropdown': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'dropdown', settings: { column: 'right', options: [{ id: 'o1', label: 'Мск' }] } }],
    },
    'column right у варианта': {
      blocks: [
        {
          id: 'b',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Да' }, { id: 'o2', label: 'Нет', column: 'right' }] },
        },
      ],
    },
    // Инертный флаг легален (спека §5): слева никого нет, но 422 быть не должно —
    // иначе undo и промежуточные состояния драга ловили бы отказ автосейва.
    'column right у первого блока — инертен, но валиден': {
      blocks: [
        { id: 'b', groupId: 'g1', type: 'email', settings: { column: 'right' } },
        { id: 'b2', groupId: 'g2', type: 'long_text', settings: {} },
      ],
    },
    'column right у первого варианта — инертен': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'multi_choice', settings: { options: [{ id: 'o1', label: 'Go', column: 'right' }] } }],
    },
    // Фаза 15 (спека §6.3): подпись — законный носитель бита. На первом блоке группы
    // он значит «моя группа справа от предыдущей» (носитель переехал сюда апгрейдом
    // v3→v4), внутри группы — «справа от предыдущего блока». Уровень задаёт место
    // блока, а поблочная проверка его не видит — поэтому оба случая просто валидны.
    'column right у подписи — кросс-групповой носитель': {
      blocks: [
        { id: 't1', groupId: 'g1', type: 'title', text: [{ t: 'Город' }], settings: {} },
        { id: 'f1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 't2', groupId: 'g2', type: 'title', text: [{ t: 'Индекс' }], settings: { column: 'right' } },
        { id: 'f2', groupId: 'g2', type: 'short_text', settings: {} },
      ],
    },
    'column right у label внутри группы — ряд «подпись | поле»': {
      blocks: [
        { id: 't', groupId: 'g1', type: 'label', text: [{ t: 'Индекс' }], settings: {} },
        { id: 'f', groupId: 'g1', type: 'short_text', settings: { column: 'right' } },
      ],
    },
    // Двухколоночная секция (спека §11, решение владельца 2026-07-29): у ключа два
    // значения. Явная форма — канон, неявная (левый элемент без ключа) читается тоже:
    // так выглядят формы, собранные до этапа. Зеркало TestValidateSchema_Valid в Go.
    'column left у обоих участников левой колонки': {
      blocks: [
        { id: 'l1', groupId: 'g1', type: 'short_text', settings: { column: 'left' } },
        { id: 'l2', groupId: 'g2', type: 'email', settings: { column: 'left' } },
        { id: 'r1', groupId: 'g3', type: 'phone', settings: { column: 'right' } },
      ],
    },
    'column left у подписи': {
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: [{ t: 'Город' }], settings: { column: 'left' } }],
    },
    'column left у варианта': {
      blocks: [
        {
          id: 'b',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Да', column: 'left' }, { id: 'o2', label: 'Нет', column: 'right' }] },
        },
      ],
    },
    // Whitelist коротких контролов отменён (2026-07-29): бит законен у любого типа,
    // включая длинный ответ, шкалу, выбор и лэйаут-блоки. Что читается в половину
    // колонки — решает автор формы, а не схема.
    'column right у long_text': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'long_text', settings: { column: 'right' } }],
    },
    'column right у single_choice': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'single_choice', settings: { column: 'right' } }],
    },
    'column right у контентного text': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'text', text: [{ t: 'абзац' }], settings: { column: 'right' } }],
    },
    // Фаза 15: заголовок формы — блок документа (спека §3.2), зеркало
    // TestValidateSchema_Valid в Go.
    'form_title первой строкой': {
      blocks: [
        { id: 'ft', groupId: 'gft', type: 'form_title', text: [{ t: 'Анкета' }] },
        { id: 't1', groupId: 'g1', type: 'title', text: [{ t: 'Имя' }] },
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    },
    'form_title с разметкой': {
      blocks: [
        {
          id: 'ft',
          groupId: 'gft',
          type: 'form_title',
          text: [{ t: 'Анкета ', m: ['b'] }, { t: '2026', color: '#c026d3' }],
        },
      ],
    },
    'form_title пустой — черновик': {
      blocks: [{ id: 'ft', groupId: 'gft', type: 'form_title', text: [] }],
    },
    'схема без form_title — как раньше': {
      blocks: [{ id: 'b1', groupId: 'g1', type: 'short_text', settings: {} }],
    },
    // Форма ровно на потолке + синтезированный заголовок = 201 блок, и это валидно:
    // потолок считает блоки АВТОРА. Иначе форма, собранная до фазы 15 на потолке,
    // перестала бы сохраняться совсем.
    'потолок блоков + заголовок формы': {
      blocks: [
        { id: 'ft', groupId: 'gft', type: 'form_title', text: [{ t: 'Анкета' }] },
        ...Array.from({ length: MAX_BLOCKS }, (_, i) => ({
          id: `b${i}`,
          groupId: `g${i}`,
          type: 'short_text',
          settings: {},
        })),
      ],
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
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', text: [{ t: 'нельзя' }], settings: {} }],
    },
    'text у image': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'image', text: [{ t: 'нельзя' }], settings: {} }],
    },
    'пустой groupId': {
      blocks: [{ id: 'b', groupId: '', type: 'short_text', settings: {} }],
    },
    'группа разорвана чужим блоком': {
      blocks: [
        { id: 'a', groupId: 'g1', type: 'title', text: [{ t: 'A' }] },
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
    // alt удалён из контракта целиком (фаза 13): strictObject отвергает его даже у image.
    'alt удалён из контракта': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'image', settings: { imageKey: 'ws/x.png', alt: 'y' } }],
    },
    'image с опциями': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'image', settings: { options: [{ id: 'o', label: 'z' }] } }],
    },
    'слишком длинный imageKey': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'image', settings: { imageKey: 'a'.repeat(MAX_IMAGE_KEY_LEN + 1) } }],
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
      blocks: [
        { id: 't', groupId: 'g1', type: 'title', text: [{ t: 'я'.repeat(MAX_TEXT_LEN + 1) }] },
      ],
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
    'column неизвестное значение': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { column: 'third' } }],
    },
    // Единственный тип вне рядов (решение владельца 2026-07-29, отменившее whitelist
    // фазы 13.6): заголовок формы. Исключён по устройству, а не по виду — он рисуется
    // вне потока вопросов, и соседей по ряду у него не бывает.
    'column у form_title': {
      blocks: [{ id: 'ft', groupId: 'gft', type: 'form_title', text: [{ t: 'Анкета' }], settings: { column: 'right' } }],
    },
    'column третьего значения': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { column: 'middle' } }],
    },
    'column у варианта вне двух значений': {
      blocks: [
        { id: 'b', groupId: 'g1', type: 'single_choice', settings: { options: [{ id: 'o1', label: 'Да', column: 'center' }] } },
      ],
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
    // Фаза 15: инварианты заголовка формы (спека §3.2), зеркало
    // TestValidateSchema_Invalid в Go.
    'два form_title': {
      blocks: [
        { id: 'f1', groupId: 'g1', type: 'form_title', text: [{ t: 'А' }] },
        { id: 'f2', groupId: 'g2', type: 'form_title', text: [{ t: 'Б' }] },
      ],
    },
    'form_title не первым блоком': {
      blocks: [
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 'ft', groupId: 'gft', type: 'form_title', text: [{ t: 'Анкета' }] },
      ],
    },
    'form_title в группе вопроса': {
      blocks: [
        { id: 'ft', groupId: 'g1', type: 'form_title', text: [{ t: 'Анкета' }] },
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
      ],
    },
    // Потолок остаётся потолком: 201 блок автора отвергается даже с заголовком.
    'больше MAX_BLOCKS блоков автора (заголовок не спасает)': {
      blocks: [
        { id: 'ft', groupId: 'gft', type: 'form_title', text: [{ t: 'Анкета' }] },
        ...Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => ({
          id: `b${i}`,
          groupId: `g${i}`,
          type: 'short_text',
          settings: {},
        })),
      ],
    },
    'слишком длинный заголовок формы': {
      blocks: [
        {
          id: 'ft',
          groupId: 'gft',
          type: 'form_title',
          text: [{ t: 'я'.repeat(MAX_FORM_TITLE_LEN + 1) }],
        },
      ],
    },
  }

  for (const [name, doc] of Object.entries(invalid)) {
    it(name, () => {
      expect(formSchemaSchema.safeParse(doc).success).toBe(false)
    })
  }
})

// Богатый текст (фаза 14, схема v3). Зеркало internal/domain/spans_test.go — оба
// набора правятся одним PR: разъехавшиеся стороны означают 422 там, где фронт
// показывает «сохранено».
describe('богатый текст блока', () => {
  const doc = (text: unknown) => ({
    schemaVersion: SCHEMA_VERSION,
    blocks: [
      { id: 't', groupId: 'g', type: 'title', text },
      { id: 'f', groupId: 'g', type: 'short_text', settings: {} },
    ],
  })

  const valid: Record<string, unknown> = {
    'простой кусок': [{ t: 'Ваше имя' }],
    'все булевы марки': [{ t: 'а', m: ['b', 'i', 'u', 's'] }],
    'цвет и фон': [{ t: 'а', color: '#c026d3', bg: '#ffff00' }],
    'ссылка': [{ t: 'политика', href: 'https://trillix.ru/privacy' }],
    'несколько кусков с разным оформлением': [
      { t: 'жир', m: ['b'] },
      { t: 'но' },
      { t: '!', color: '#000000' },
    ],
    'пустой массив — недособранный черновик': [],
    'два подряд одинаковых куска — склейка НЕ обязанность валидатора': [{ t: 'а' }, { t: 'б' }],
  }
  for (const [name, text] of Object.entries(valid)) {
    it(`валидно: ${name}`, () => {
      expect(formSchemaSchema.safeParse(doc(text)).success).toBe(true)
    })
  }

  const invalid: Record<string, unknown> = {
    'пустой кусок': [{ t: '' }],
    'пустой кусок в середине': [{ t: 'а' }, { t: '' }, { t: 'б' }],
    'строка вместо массива': 'просто строка',
    'лишнее поле спана': [{ t: 'а', bold: true }],
    'неизвестная марка': [{ t: 'а', m: ['blink'] }],
    'повторяющаяся марка': [{ t: 'а', m: ['b', 'b'] }],
    'цвет словом': [{ t: 'а', color: 'red' }],
    'цвет в rgb()': [{ t: 'а', color: 'rgb(1,2,3)' }],
    'цвет в верхнем регистре': [{ t: 'а', color: '#C026D3' }],
    'цвет тремя цифрами': [{ t: 'а', color: '#abc' }],
    'фон по тому же правилу': [{ t: 'а', bg: 'salmon' }],
    // Инвариант 4: единственная марка с угрозой безопасности.
    'ссылка javascript:': [{ t: 'а', href: 'javascript:alert(1)' }],
    'ссылка data:': [{ t: 'а', href: 'data:text/html,x' }],
    'ссылка относительная': [{ t: 'а', href: '/privacy' }],
    'суммарная длина сверх лимита': [
      { t: 'я'.repeat(MAX_TEXT_LEN) },
      { t: 'лишний', m: ['b'] },
    ],
    'кусков больше лимита': Array.from({ length: MAX_SPANS + 1 }, () => ({ t: 'я' })),
  }
  for (const [name, text] of Object.entries(invalid)) {
    it(`невалидно: ${name}`, () => {
      expect(formSchemaSchema.safeParse(doc(text)).success).toBe(false)
    })
  }

  // Лимит числа кусков ловит ровно то, чего не ловит лимит длины: MAX_SPANS + 1
  // односимвольных кусков короче MAX_TEXT_LEN, то есть по длине документ законен.
  it('лимит числа кусков ловит то, чего не ловит лимит длины', () => {
    const many = Array.from({ length: MAX_SPANS + 1 }, () => ({ t: 'я' }))
    expect(many.length).toBeLessThan(MAX_TEXT_LEN)
    expect(formSchemaSchema.safeParse(doc(many)).success).toBe(false)
    expect(formSchemaSchema.safeParse(doc(many.slice(0, MAX_SPANS))).success).toBe(true)
  })
})

describe('plainText / textFromString / sameRichText', () => {
  it('plainText склеивает куски и не отдаёт разметку', () => {
    expect(plainText([{ t: 'жир', m: ['b'] }, { t: 'но' }])).toBe('жирно')
    expect(plainText([{ t: 'сюда', href: 'https://a.ru' }])).toBe('сюда')
    expect(plainText(undefined)).toBe('')
  })

  it('textFromString: пустая строка даёт пустой массив, не кусок с пустотой', () => {
    expect(textFromString('')).toEqual([])
    expect(textFromString('абв')).toEqual([{ t: 'абв' }])
  })

  // Сравнение по значению, а не по ссылке: каждый набранный символ приносит свежий
  // массив с тем же содержимым, и по ссылке no-op в updateBlock перестал бы работать
  // (лишний шаг истории, dirty, лишний PATCH).
  it('sameRichText сравнивает по значению', () => {
    expect(sameRichText(textFromString('а'), textFromString('а'))).toBe(true)
    expect(sameRichText(undefined, [])).toBe(true)
    expect(sameRichText(textFromString('а'), textFromString('б'))).toBe(false)
    expect(sameRichText([{ t: 'а' }], [{ t: 'а', m: ['b'] }])).toBe(false)
    expect(sameRichText([{ t: 'а', m: ['b'] }], [{ t: 'а', m: ['i'] }])).toBe(false)
    expect(sameRichText([{ t: 'а', color: '#000000' }], [{ t: 'а' }])).toBe(false)
    expect(sameRichText([{ t: 'а' }], [{ t: 'а' }, { t: 'б' }])).toBe(false)
  })
})
