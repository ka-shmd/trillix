import {
  type AnswerValue,
  type PartialSubmission,
  type Submission,
} from '../../entities/submission'

// Раздел «Ответы» показывает ДВА множества — отправленные ответы и незавершённые
// (`partial_submissions`), — и таблица, окно строки и подтверждение удаления у них
// одни. Общая форма строки живёт здесь, чтобы вкладка «Частичные» не завела вторую
// таблицу: полторы сотни строк вёрстки, которые расходятся с оригиналом на первой же
// правке, — цена дороже, чем один тип с полем kind.
//
// KIND ЕДЕТ В САМОЙ СТРОКЕ, а не отдельным пропом рядом: пропом его можно передать
// не тот, и окно подтверждения тогда пообещало бы удалить не то, что удалит.
export type AnswerRowKind = 'submission' | 'partial'

export type AnswerRow = {
  kind: AnswerRowKind
  // id строки: у ответа — его id, у черновика — id ВИЗИТА (черновик принадлежит
  // визиту). Им же адресуется удаление, поэтому поле одно.
  id: string
  formVersion: number
  // at — время в колонке даты: у ответа отправка, у черновика последняя правка.
  at: string
  answers: Record<string, AnswerValue>
  // lastBlockId — вопрос, на котором человек остановился. Только у черновика; у
  // отправленного ответа остановки не было.
  lastBlockId: string
  // Источник и устройство визита ответа; нет — визита нет или строка из ленты.
  visitSource?: string
  visitDevice?: string
}

// Слова, которыми экран называет строку. Таблицей, а не ветвлением по месту
// употребления: заголовок окна, подпись значка и вопрос подтверждения обязаны
// называть одно и то же одинаково, а разъезжаются они именно тогда, когда лежат в
// трёх разных файлах.
export const ROW_WORDS: Record<
  AnswerRowKind | 'mixed',
  { one: string; oneLower: string; dateColumn: string; deleteHint: string }
> = {
  // mixed — вкладка «Все ответы», где в одной таблице оба вида. Колонка даты
  // называется нейтрально: «Дата отправки» над черновиком, который никто не
  // отправлял, — прямое враньё, а «Последняя правка» над отправленным ответом
  // обещает правки, которых не было. Какой именно вид в строке, говорит метка
  // рядом с датой, а не заголовок колонки.
  mixed: {
    one: 'Запись',
    oneLower: 'запись',
    dateColumn: 'Дата',
    deleteHint: 'Запись исчезнет из таблицы.',
  },
  submission: {
    one: 'Ответ',
    oneLower: 'ответ',
    dateColumn: 'Дата отправки',
    deleteHint: 'Ответ исчезнет из таблицы, выгрузки и сводки.',
  },
  partial: {
    one: 'Незавершённый ответ',
    oneLower: 'незавершённый ответ',
    dateColumn: 'Последняя правка',
    deleteHint: 'Незавершённый ответ исчезнет из вкладки «Частичные».',
  },
}

// Строка листинга раздела «Ответы» — уже размеченная сервером: `kind` приходит с
// ней, а не выводится тут. Время колонки — «последняя активность»: у ответа отправка,
// у черновика последняя правка, ровно то, по чему лента и отсортирована.
export function listRow(s: Submission): AnswerRow {
  return {
    kind: s.kind,
    id: s.id,
    formVersion: s.formVersion,
    at: s.updatedAt ?? s.createdAt,
    answers: s.answers,
    lastBlockId: s.lastBlockId,
    visitSource: s.visitSource,
    visitDevice: s.visitDevice,
  }
}

export function partialRow(p: PartialSubmission): AnswerRow {
  return {
    kind: 'partial',
    id: p.visitId,
    formVersion: p.formVersion,
    at: p.updatedAt,
    answers: p.answers,
    lastBlockId: p.lastBlockId,
  }
}

// Какими словами таблица называет свои строки. Смешанная страница — своя третья
// раскладка, а не слова первой строки: заголовок колонки один на всю таблицу, и
// строка, попавшая в неё первой, не имеет права называть остальные.
export function rowWords(rows: readonly AnswerRow[]) {
  const first = rows[0]
  if (!first) return ROW_WORDS.submission
  return rows.some((r) => r.kind !== first.kind) ? ROW_WORDS.mixed : ROW_WORDS[first.kind]
}
