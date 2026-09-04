import { type Period } from '../../shared/period'

// Фабрика query-ключей submissions: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md), только отсюда. Ключи вложены по formId — инвалидация
// ответов одной формы не трогает другие.
// Период — часть ключа сводки и счётчика: без него переключение окна отдавало бы
// кеш предыдущего, и экран молча показывал бы числа не того периода. Отсюда пары
// ключей: *AllPeriods — префикс на инвалидацию всех окон сразу (удалённый ответ
// обязан исчезнуть не только из открытого).
export const submissionKeys = {
  all: () => ['submissions'] as const,
  // kind — часть ключа: «Все ответы» и «Законченные» это два РАЗНЫХ множества с
  // разными курсорами, и общий кеш подсунул бы одной вкладке страницы другой.
  list: (formId: string, kind: string) => ['submissions', 'list', formId, kind] as const,
  listAllKinds: (formId: string) => ['submissions', 'list', formId] as const,
  summaryAllPeriods: (formId: string) => ['submissions', 'summary', formId] as const,
  summary: (formId: string, period: Period) => ['submissions', 'summary', formId, period] as const,
  countAllPeriods: (formId: string) => ['submissions', 'count', formId] as const,
  count: (formId: string, period: Period) => ['submissions', 'count', formId, period] as const,
  // Один ответ по id — окну, открытому не из списка (карточка записи на полотне
  // расписания). Под своим ключом, а не под списком: список ключуется видом и
  // курсором, и подмешивать в него одиночный ответ значило бы ронять его страницы
  // при каждом открытии окна.
  one: (formId: string, submissionId: string) =>
    ['submissions', 'one', formId, submissionId] as const,
  // Черновики — свой ключ рядом со списком ответов, а не под ним: это другое
  // множество, и удаление ответа не имеет права трогать его кеш.
  partials: (formId: string) => ['submissions', 'partials', formId] as const,
  // Значения одного вопроса лежат ПОД ключом сводки: удаление ответа инвалидирует
  // сводку префиксом, и окно «все ответы» обязано перечитаться вместе с ней —
  // иначе в нём останется ответ, которого уже нет в распределении над ним.
  blockAnswers: (formId: string, period: Period, blockId: string) =>
    ['submissions', 'summary', formId, period, 'answers', blockId] as const,
}
