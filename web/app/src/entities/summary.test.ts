import { describe, expect, it } from 'vitest'
import {
  blockAnswersPageSchema,
  crosstabSchema,
  formSummarySchema,
  type BlockSummary,
  type FormSummary,
} from './summary'

// Индексация массива под noUncheckedIndexedAccess даёт `T | undefined`: достаём
// вопрос явно, чтобы падало осмысленным сообщением, а не на первом же обращении.
function blockAt(summary: FormSummary, i: number): BlockSummary {
  const block = summary.blocks[i]
  if (!block) throw new Error(`в сводке нет вопроса #${i}`)
  return block
}

// Контракт сводки: Zod-схема обязана принимать то, что реально отдаёт Go
// (internal/submissions/handler.go). Фикстура ниже — НЕ выдумана: это дословный
// ответ сервера, снятый curl'ом с dev-контура на форме со всеми новыми типами
// (фаза 8.5 шаг 2). Придуманная фикстура проверяла бы схему сама против себя и
// рассинхрон контракта пропустила бы.
const realServerPayload = {
  total: 1,
  blocks: [
    // Телефон: kind=fill — buckets сервер не шлёт вовсе (omitempty).
    {
      blockId: 'tel',
      label: 'Телефон',
      type: 'phone',
      kind: 'fill',
      asked: 1,
      answered: 1,
      // У текстовых типов сервер шлёт последние значения — ради них раскладка и
      // переехала на формат Tally.
      samples: [{ text: '+7 900 000-00-00', at: '2026-08-24T09:15:00Z' }],
    },
    {
      blockId: 'city',
      label: 'Город',
      type: 'dropdown',
      kind: 'distribution',
      asked: 1,
      answered: 1,
      buckets: [
        { key: 'msk', label: 'Москва', count: 1 },
        { key: 'spb', label: 'Питер', count: 0 },
      ],
    },
    {
      blockId: 'nps',
      label: 'Насколько полезно?',
      type: 'scale',
      kind: 'distribution',
      asked: 1,
      answered: 1,
      buckets: [
        { key: '0', label: '0', count: 1 },
        { key: '1', label: '1', count: 0 },
        { key: '2', label: '2', count: 0 },
        { key: '3', label: '3', count: 0 },
        { key: '4', label: '4', count: 0 },
        { key: '5', label: '5', count: 0 },
        { key: '6', label: '6', count: 0 },
        { key: '7', label: '7', count: 0 },
        { key: '8', label: '8', count: 0 },
        { key: '9', label: '9', count: 0 },
        { key: '10', label: '10', count: 0 },
      ],
      // scale ниже дописан по DTO (фаза 30): средняя и NPS шкалы 0–10 с
      // единственным ответом «0» и ряд по суткам.
      scale: { avg: 0, nps: -100, step: 'day', trend: [{ at: '2026-08-24T00:00:00Z', n: 1, avg: 0 }] },
    },
  ],
}

describe('formSummarySchema', () => {
  it('принимает реальный ответ сервера', () => {
    const parsed = formSummarySchema.parse(realServerPayload)
    expect(parsed.total).toBe(1)
    expect(parsed.blocks).toHaveLength(3)
  })

  // Вопрос без распределения (fill) приходит вовсе без ключа buckets: схема обязана
  // дать пустой массив, иначе страница падает на .map() у первого же текстового
  // вопроса.
  it('вопросу без buckets подставляет пустой массив', () => {
    const phone = blockAt(formSummarySchema.parse(realServerPayload), 0)
    expect(phone.kind).toBe('fill')
    expect(phone.buckets).toEqual([])
  })

  // Ноль — законное деление шкалы (NPS 0–10). Проверяем сквозь схему: если бы
  // scaleMin=0 где-то по дороге выпал, деления начинались бы с единицы.
  it('сохраняет нулевое деление шкалы', () => {
    const nps = blockAt(formSummarySchema.parse(realServerPayload), 2)
    expect(nps.buckets[0]).toEqual({ key: '0', label: '0', count: 1 })
    expect(nps.buckets).toHaveLength(11)
  })

  // Шкала: средняя, NPS и ряд. NPS −100 — законное значение, а не «нет данных».
  it('разбирает статистику шкалы', () => {
    const nps = blockAt(formSummarySchema.parse(realServerPayload), 2)
    expect(nps.scale?.nps).toBe(-100)
    expect(nps.scale?.trend).toHaveLength(1)
    expect(blockAt(formSummarySchema.parse(realServerPayload), 0).scale).toBeFalsy()
  })

  // Статистика чисел необязательна: её нет у вопросов другого вида и у числового
  // вопроса, на который никто не ответил.
  it('принимает числовой вопрос со статистикой и без неё', () => {
    const withStats = formSummarySchema.parse({
      total: 1,
      blocks: [
        {
          blockId: 'age',
          label: 'Возраст',
          type: 'number',
          kind: 'number',
          asked: 3,
          answered: 3,
          number: { avg: 30, median: 28, min: 20, max: 40 },
        },
      ],
    })
    expect(blockAt(withStats, 0).number).toEqual({ avg: 30, median: 28, min: 20, max: 40 })

    const noStats = formSummarySchema.parse({
      total: 1,
      blocks: [
        { blockId: 'age', label: 'Возраст', type: 'number', kind: 'number', asked: 1, answered: 0 },
      ],
    })
    expect(blockAt(noStats, 0).number).toBeFalsy()
  })

  // Неизвестный вид сводки — расхождение контракта: схема обязана падать здесь, на
  // границе, а не отдавать странице объект, который она не умеет рисовать.
  it('отвергает неизвестный kind', () => {
    expect(() =>
      formSummarySchema.parse({
        total: 1,
        blocks: [
          {
            blockId: 'x',
            label: 'X',
            type: 'short_text',
            kind: 'sparkline',
            asked: 1,
            answered: 1,
          },
        ],
      }),
    ).toThrow()
  })
})

describe('последние ответы в сводке', () => {
  it('вопрос без значений получает пустой массив, а не undefined', () => {
    // Сервер шлёт поле с omitempty, поэтому у распределений его нет вовсе, а экран
    // обязан обходиться без ветки «а есть ли поле».
    const parsed = formSummarySchema.parse(realServerPayload)
    expect(blockAt(parsed, 1).samples).toEqual([])
  })

  it('значения приходят текстом и временем', () => {
    const parsed = formSummarySchema.parse(realServerPayload)
    const phone = blockAt(parsed, 0)
    expect(phone.samples[0]?.text).toBe('+7 900 000-00-00')
    expect(phone.samples[0]?.at).toBe('2026-08-24T09:15:00Z')
  })
})

// Контракт окна «все ответы на вопрос». Фикстура снята с настоящего ответа сервера
// (интеграционный прогон против Postgres, форма summarySchemaV1): смещение +03:00
// во времени и base64-курсор — как есть, не приведённые к удобному виду. Выдуманная
// фикстура проверяла бы схему саму против себя.
describe('страница значений одного вопроса', () => {
  const realServerPage = {
    answers: [
      { text: 'Хотелось бы больше вариантов оплаты.', at: '2026-08-26T15:45:44.019801+03:00' },
    ],
    nextCursor: 'MDFhMDNlMWEtZTBkMy03YWYzLTljYjEtZDkzY2UyZjBhYWI2',
  }

  it('принимает ответ сервера как есть', () => {
    const page = blockAnswersPageSchema.parse(realServerPage)
    expect(page.answers).toHaveLength(1)
    expect(page.nextCursor).toBe(realServerPage.nextCursor)
  })

  // null — не «нет поля», а «ответы кончились»: по нему окно перестаёт листать.
  it('пустой курсор на последней странице — null, а не отсутствие поля', () => {
    const page = blockAnswersPageSchema.parse({ answers: [], nextCursor: null })
    expect(page.nextCursor).toBeNull()
  })
})

describe('crosstabSchema', () => {
  // Форма ответа — по DTO crosstabResponse (internal/submissions/handler.go).
  it('разбирает таблицу', () => {
    const parsed = crosstabSchema.parse({
      rows: [{ key: 'o1', label: 'Друзья', total: 2 }],
      cols: [{ key: '5', label: '5', total: 1 }],
      cells: [[1]],
      total: 2,
    })
    expect(parsed.cells[0]?.[0]).toBe(1)
  })
})
