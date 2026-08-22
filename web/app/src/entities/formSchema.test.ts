import { describe, expect, it } from 'vitest'
import {
  coverY,
  COVER_HEIGHT_MAX,
  COVER_HEIGHT_MIN,
  COVER_Y_MAX,
  COVER_Y_MIN,
  DEFAULT_COVER_Y,
  formSchemaSchema,
  LOGO_RADIUS_MAX,
  LOGO_RADIUS_MIN,
  LOGO_SIZE_MAX,
  LOGO_SIZE_MIN,
  isValidPhone,
  MAX_BLOCKS,
  MAX_FORM_TITLE_LEN,
  MAX_IMAGE_KEY_LEN,
  MAX_OPTIONS,
  MAX_PAGE_NAME_LEN,
  MAX_PLACEHOLDER_LEN,
  MAX_QUESTION_NAME_LEN,
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
    // Имя вопроса (фаза 16, этап 16.4): необязательное переопределение у отвечаемого.
    // Пустая строка тоже валидна — «имя не задано»; канон её не хранит (Go omitempty).
    'имя у отвечаемого блока': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [
        { id: 't1', groupId: 'g1', type: 'title', text: [{ t: 'Как вас зовут?' }] },
        { id: 'b1', groupId: 'g1', type: 'short_text', name: 'fio', settings: {} },
      ],
    },
    'пустое имя': {
      blocks: [{ id: 'b1', groupId: 'g1', type: 'short_text', name: '', settings: {} }],
    },
    'имя ровно в лимит': {
      blocks: [
        {
          id: 'b1',
          groupId: 'g1',
          type: 'short_text',
          name: 'я'.repeat(MAX_QUESTION_NAME_LEN),
          settings: {},
        },
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
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { column: 2 } }],
    },
    'column right у dropdown': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'dropdown', settings: { column: 2, options: [{ id: 'o1', label: 'Мск' }] } }],
    },
    'column right у варианта': {
      blocks: [
        {
          id: 'b',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Да' }, { id: 'o2', label: 'Нет', column: 2 }] },
        },
      ],
    },
    // Инертный флаг легален (спека §5): слева никого нет, но 422 быть не должно —
    // иначе undo и промежуточные состояния драга ловили бы отказ автосейва.
    'column right у первого блока — инертен, но валиден': {
      blocks: [
        { id: 'b', groupId: 'g1', type: 'email', settings: { column: 2 } },
        { id: 'b2', groupId: 'g2', type: 'long_text', settings: {} },
      ],
    },
    'column right у первого варианта — инертен': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'multi_choice', settings: { options: [{ id: 'o1', label: 'Go', column: 2 }] } }],
    },
    // Фаза 15 (спека §6.3): подпись — законный носитель бита. На первом блоке группы
    // он значит «моя группа справа от предыдущей» (носитель переехал сюда апгрейдом
    // v3→v4), внутри группы — «справа от предыдущего блока». Уровень задаёт место
    // блока, а поблочная проверка его не видит — поэтому оба случая просто валидны.
    'column right у подписи — кросс-групповой носитель': {
      blocks: [
        { id: 't1', groupId: 'g1', type: 'title', text: [{ t: 'Город' }], settings: {} },
        { id: 'f1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 't2', groupId: 'g2', type: 'title', text: [{ t: 'Индекс' }], settings: { column: 2 } },
        { id: 'f2', groupId: 'g2', type: 'short_text', settings: {} },
      ],
    },
    'column right у label внутри группы — ряд «подпись | поле»': {
      blocks: [
        { id: 't', groupId: 'g1', type: 'label', text: [{ t: 'Индекс' }], settings: {} },
        { id: 'f', groupId: 'g1', type: 'short_text', settings: { column: 2 } },
      ],
    },
    // Двухколоночная секция (спека §11, решение владельца 2026-07-29): у ключа два
    // значения. Явная форма — канон, неявная (левый элемент без ключа) читается тоже:
    // так выглядят формы, собранные до этапа. Зеркало TestValidateSchema_Valid в Go.
    'column left у обоих участников левой колонки': {
      blocks: [
        { id: 'l1', groupId: 'g1', type: 'short_text', settings: { column: 1 } },
        { id: 'l2', groupId: 'g2', type: 'email', settings: { column: 1 } },
        { id: 'r1', groupId: 'g3', type: 'phone', settings: { column: 2 } },
      ],
    },
    'column left у подписи': {
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: [{ t: 'Город' }], settings: { column: 1 } }],
    },
    'column left у варианта': {
      blocks: [
        {
          id: 'b',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Да', column: 1 }, { id: 'o2', label: 'Нет', column: 2 }] },
        },
      ],
    },
    // Доли колонок (2026-08-22, ADR §10). Ряд, где доли НЕ сходятся, тоже валиден:
    // сумма кросс-блочна, её считает раскладчик (rowWidths), а не схема — иначе
    // добавление колонки в ряд ловило бы 422 до того, как канон раздаст новые доли.
    'доли колонок сходятся': {
      blocks: [
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: { column: 1, columnWidth: 70 } },
        { id: 'b2', groupId: 'g2', type: 'email', settings: { column: 2, columnWidth: 30 } },
      ],
    },
    'доли колонок не сходятся — инертны, но валидны': {
      blocks: [
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: { column: 1, columnWidth: 70 } },
        { id: 'b2', groupId: 'g2', type: 'email', settings: { column: 2, columnWidth: 70 } },
      ],
    },
    'доля колонки у варианта': {
      blocks: [
        {
          id: 'b',
          groupId: 'g1',
          type: 'single_choice',
          settings: {
            options: [
              { id: 'o1', label: 'Да', column: 1, columnWidth: 60 },
              { id: 'o2', label: 'Нет', column: 2, columnWidth: 40 },
            ],
          },
        },
      ],
    },
    // Whitelist коротких контролов отменён (2026-07-29): бит законен у любого типа,
    // включая длинный ответ, шкалу, выбор и лэйаут-блоки. Что читается в половину
    // колонки — решает автор формы, а не схема.
    'column right у long_text': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'long_text', settings: { column: 2 } }],
    },
    'column right у single_choice': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'single_choice', settings: { column: 2 } }],
    },
    'column right у контентного text': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'text', text: [{ t: 'абзац' }], settings: { column: 2 } }],
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
    // Три случая «инертного ключа настроек» (фаза 16, blocks/settings.ts OWNED_SETTINGS).
    // У ключей РАЗНОЕ понятие пустоты, и это не небрежность, а совместимость: документы
    // ниже валидны с самого появления настроек, и одна общая проверка «ключ есть → он
    // чужой» начала бы их отвергать. Проверяются здесь, чтобы следующая уборка не
    // «причесала» правило и не сломала молча уже сохранённые формы.
    'пустой список опций у не-choice — ничего не задано': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { options: [] } }],
    },
    'пустой imageKey у не-image': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { imageKey: '' } }],
    },
    // Плейсхолдер — подсказка РЕДАКТОРА, а не правило схемы: у типов без ввода он
    // игнорируется и не запрещается (в отличие от опций, картинки и шкалы).
    'плейсхолдер у шкалы игнорируется, но валиден': {
      blocks: [
        { id: 'b', groupId: 'g1', type: 'scale', settings: { scaleMin: 1, scaleMax: 5, placeholder: 'x' } },
      ],
    },
    // Значимый нуль: scaleMin: 0 — ЗАДАННОЕ значение (NPS), а не «не задано».
    'шкала NPS от нуля': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'scale', settings: { scaleMin: 0, scaleMax: 10 } }],
    },
    // Настройки страницы у разрыва (2026-08-21). Оба ключа — свойства страницы, которую
    // разрыв открывает; условия действия флага thankYou кросс-блочны и потому здесь НЕ
    // проверяются (флаг инертен, а не невалиден — как бит колонки).
    'имя страницы у разрыва': {
      blocks: [
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 'pb', groupId: 'g2', type: 'page_break', settings: { pageName: 'Контакты' } },
        { id: 'b2', groupId: 'g3', type: 'email', settings: {} },
      ],
    },
    'флаг страницы «Спасибо» у разрыва': {
      blocks: [
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 'pb', groupId: 'g2', type: 'page_break', settings: { thankYou: true } },
        { id: 'h', groupId: 'g3', type: 'heading', text: [{ t: 'Спасибо!' }] },
      ],
    },
    // Флаг, которому некуда примениться: разрыв последним блоком страницы не открывает.
    // То же правило, что у инертного бита колонки, — иначе набор и undo ловили бы 422.
    'инертный флаг «Спасибо» на разрыве в конце': {
      blocks: [
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 'pb', groupId: 'g2', type: 'page_break', settings: { thankYou: true } },
      ],
    },
    // Действующая страница «Спасибо» не терпит отвечаемых блоков — но решает это
    // раскладчик, а не схема: документ ниже валиден, просто флаг на нём инертен.
    'вопрос на странице «Спасибо» — флаг инертен, документ валиден': {
      blocks: [
        { id: 'b1', groupId: 'g1', type: 'short_text', settings: {} },
        { id: 'pb', groupId: 'g2', type: 'page_break', settings: { thankYou: true } },
        { id: 'b2', groupId: 'g3', type: 'email', settings: {} },
      ],
    },
    'пустое имя страницы у не-разрыва': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { pageName: '' } }],
    },
    'thankYou: false у не-разрыва': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { thankYou: false } }],
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
    // Имя называет колонку CSV и шаг воронки — у неотвечаемого блока называть нечего.
    'имя у подписи': {
      blocks: [{ id: 't', groupId: 'g1', type: 'title', text: [{ t: 'Вопрос' }], name: 'q1' }],
    },
    'имя у контента': {
      blocks: [{ id: 'p', groupId: 'g1', type: 'text', text: [{ t: 'Пояснение' }], name: 'q1' }],
    },
    'слишком длинное имя': {
      blocks: [
        {
          id: 'b',
          groupId: 'g1',
          type: 'short_text',
          name: 'я'.repeat(MAX_QUESTION_NAME_LEN + 1),
          settings: {},
        },
      ],
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
    // Настройки страницы принадлежат разрыву: на чужом типе они бессмысленны, а молча
    // принятый бессмысленный ключ доживает до читателя, который решит, что он значим.
    'имя страницы на не-разрыве': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { pageName: 'Контакты' } }],
    },
    'флаг «Спасибо» на не-разрыве': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'heading', text: [{ t: 'x' }], settings: { thankYou: true } }],
    },
    'слишком длинное имя страницы': {
      blocks: [
        {
          id: 'pb',
          groupId: 'g1',
          type: 'page_break',
          settings: { pageName: 'я'.repeat(MAX_PAGE_NAME_LEN + 1) },
        },
      ],
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
    // ЗНАЧИМЫЙ НУЛЬ у чужого типа: scaleMin: 0 — заданное значение (NPS считается от
    // нуля), а не «ключа нет». Единственный сторож правила: у самой шкалы ключ
    // закреплён, и понятие «наличия» там не проверяется вовсе, поэтому случай обязан
    // стоять на НЕ-scale типе (найдено ревью этапа 16.1а). Ослабление проверки до
    // Boolean(v) в blocks/settings.ts делает этот документ валидным на фронте, тогда как
    // Go (ScaleMin *int) продолжает его отвергать: билдер считает черновик целым, а
    // автосейв ловит 422 без привязки к полю.
    'шкала-минимум ноль у не-scale': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { scaleMin: 0 } }],
    },
    'шкала-максимум ноль у не-scale': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { scaleMax: 0 } }],
    },
    'column неизвестное значение': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { column: 'third' } }],
    },
    // Единственный тип вне рядов (решение владельца 2026-07-29, отменившее whitelist
    // фазы 13.6): заголовок формы. Исключён по устройству, а не по виду — он рисуется
    // вне потока вопросов, и соседей по ряду у него не бывает.
    'column у form_title': {
      blocks: [{ id: 'ft', groupId: 'gft', type: 'form_title', text: [{ t: 'Анкета' }], settings: { column: 2 } }],
    },
    'column третьего значения': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { column: 'middle' } }],
    },
    'column у варианта вне двух значений': {
      blocks: [
        { id: 'b', groupId: 'g1', type: 'single_choice', settings: { options: [{ id: 'o1', label: 'Да', column: 'center' }] } },
      ],
    },
    // Доля колонки: диапазон и тот же запрет у типа вне рядов, что у column.
    'columnWidth выше потолка': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { columnWidth: 101 } }],
    },
    'columnWidth нулевой': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { columnWidth: 0 } }],
    },
    'columnWidth дробный': {
      blocks: [{ id: 'b', groupId: 'g1', type: 'short_text', settings: { columnWidth: 33.5 } }],
    },
    'columnWidth у form_title': {
      blocks: [
        { id: 'ft', groupId: 'gft', type: 'form_title', text: [{ t: 'Анкета' }], settings: { columnWidth: 50 } },
      ],
    },
    'columnWidth варианта выше потолка': {
      blocks: [
        {
          id: 'b',
          groupId: 'g1',
          type: 'single_choice',
          settings: { options: [{ id: 'o1', label: 'Да', columnWidth: 120 }] },
        },
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
    'подстановка ответа': [{ t: 'Имя', ref: 'blk_1' }, { t: ', укажите телефон' }],
    'подстановка с маркой': [{ t: 'Имя', ref: 'blk_1', m: ['b'] }],
    // Инертность, а не отказ (mentions.md §4): валидатор состава документа не знает и
    // знать не должен — иначе удаление вопроса-источника роняло бы автосейв.
    'подстановка на несуществующий блок': [{ t: 'Имя', ref: 'нет такого' }],
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
    'подстановка пустым id': [{ t: 'Имя', ref: '' }],
    'подстановка и ссылка на одном куске': [{ t: 'а', ref: 'blk_1', href: 'https://a.ru' }],
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
    // Данные получают ИМЯ вопроса-источника, а не чей-то ответ: подстановка живёт на
    // клиенте и до CSV, воронки и og:description не доходит вовсе.
    expect(plainText([{ t: 'Имя', ref: 'blk_1' }, { t: ', телефон' }])).toBe('Имя, телефон')
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
    // Чип, перенацеленный на другой вопрос или потерявший источник, отличается от
    // прежнего ТОЛЬКО этим полем: без сравнения по ref правка не доехала бы ни до
    // истории, ни до автосейва.
    expect(sameRichText([{ t: 'Имя', ref: 'b1' }], [{ t: 'Имя', ref: 'b2' }])).toBe(false)
    expect(sameRichText([{ t: 'Имя', ref: 'b1' }], [{ t: 'Имя' }])).toBe(false)
  })
})

// Оформление страницы: обложка и логотип. Зеркало TestValidateSchema_CoverAndLogo
// в internal/domain/schema_test.go — оба набора правятся одним PR: разъехавшиеся
// стороны означают 422 там, где фронт показывает «сохранено».
describe('обложка и логотип', () => {
  const longKey = 'a'.repeat(MAX_IMAGE_KEY_LEN + 1)

  const valid: Record<string, unknown> = {
    'обложки нет вовсе': { schemaVersion: SCHEMA_VERSION, blocks: [] },
    'обложка цветом': { schemaVersion: SCHEMA_VERSION, blocks: [], cover: { color: '#ff8800' } },
    'обложка картинкой': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { imageKey: 'ws/deadbeef.jpg' },
    },
    'обложка со сдвигом': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { imageKey: 'ws/x.jpg', y: 20 },
    },
    'сдвиг у верхней границы': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { imageKey: 'ws/x.jpg', y: COVER_Y_MAX },
    },
    логотип: { schemaVersion: SCHEMA_VERSION, blocks: [], logo: { imageKey: 'ws/logo.png' } },
    'логотип с размером': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      logo: { imageKey: 'ws/logo.png', width: 140, height: 80, radius: LOGO_RADIUS_MIN },
    },
    'логотип у границ размера': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      logo: {
        imageKey: 'ws/logo.png',
        width: LOGO_SIZE_MIN,
        height: LOGO_SIZE_MAX,
        radius: LOGO_RADIUS_MAX,
      },
    },
    // Высота полосы осмысленна у обоих наполнений — в отличие от сдвига, который
    // при цвете отвергается.
    'высота обложки у цвета': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { color: '#ff8800', height: 40 },
    },
    'высота обложки у картинки': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { imageKey: 'ws/x.jpg', height: COVER_HEIGHT_MIN },
    },
    'обложка и логотип вместе': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { imageKey: 'ws/x.jpg', y: COVER_Y_MIN },
      logo: { imageKey: 'ws/logo.png' },
    },
  }

  for (const [name, doc] of Object.entries(valid)) {
    it('валидна: ' + name, () => {
      expect(formSchemaSchema.safeParse(doc).success).toBe(true)
    })
  }

  const invalid: Record<string, unknown> = {
    'обложка пуста': { schemaVersion: SCHEMA_VERSION, blocks: [], cover: {} },
    'цвет и картинка разом': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { color: '#ffffff', imageKey: 'ws/x.jpg' },
    },
    'цвет не hex': { schemaVersion: SCHEMA_VERSION, blocks: [], cover: { color: 'red' } },
    'цвет в верхнем регистре': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { color: '#FF8800' },
    },
    // Инвариант 4: значение уходит в inline-style рендерера, свободный CSS туда не пускаем.
    'цвет со свободным CSS': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { color: 'url(javascript:alert(1))' },
    },
    'сдвиг без картинки': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { color: '#ff8800', y: 30 },
    },
    'сдвиг выше потолка': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { imageKey: 'ws/x.jpg', y: COVER_Y_MAX + 1 },
    },
    'сдвиг ниже нуля': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { imageKey: 'ws/x.jpg', y: COVER_Y_MIN - 1 },
    },
    'дробный сдвиг': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { imageKey: 'ws/x.jpg', y: 12.5 },
    },
    'слишком длинный ключ': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { imageKey: longKey },
    },
    'лишний ключ у обложки': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { color: '#ff8800', x: 10 },
    },
    'логотип с пустым ключом': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      logo: { imageKey: '' },
    },
    'логотип с длинным ключом': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      logo: { imageKey: longKey },
    },
    'логотип без ключа': { schemaVersion: SCHEMA_VERSION, blocks: [], logo: {} },
    'логотип уже минимума': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      logo: { imageKey: 'ws/logo.png', width: LOGO_SIZE_MIN - 1 },
    },
    'логотип выше потолка': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      logo: { imageKey: 'ws/logo.png', height: LOGO_SIZE_MAX + 1 },
    },
    'скругление логотипа выше потолка': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      logo: { imageKey: 'ws/logo.png', radius: LOGO_RADIUS_MAX + 1 },
    },
    'отрицательное скругление логотипа': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      logo: { imageKey: 'ws/logo.png', radius: LOGO_RADIUS_MIN - 1 },
    },
    'дробный размер логотипа': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      logo: { imageKey: 'ws/logo.png', width: 100.5 },
    },
    'высота обложки ниже минимума': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { color: '#ff8800', height: COVER_HEIGHT_MIN - 1 },
    },
    'высота обложки выше потолка': {
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      cover: { color: '#ff8800', height: COVER_HEIGHT_MAX + 1 },
    },
  }

  for (const [name, doc] of Object.entries(invalid)) {
    it('невалидна: ' + name, () => {
      expect(formSchemaSchema.safeParse(doc).success).toBe(false)
    })
  }

  // «Нет ключа» = центр, y:0 = прижата верхом. Перепутать их значит незаметно
  // сдвигать чужие обложки на середину.
  it('coverY: ноль переживает разбор, отсутствие даёт центр', () => {
    expect(coverY({ imageKey: 'ws/x.jpg', y: 0 })).toBe(0)
    expect(coverY({ imageKey: 'ws/x.jpg' })).toBe(DEFAULT_COVER_Y)
    expect(coverY(undefined)).toBe(DEFAULT_COVER_Y)
  })
})
