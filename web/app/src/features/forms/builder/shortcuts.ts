// shortcuts.ts — единый источник карты шорткатов полотна (§3.2 DESIGN-canvas-rework).
// Одно место, откуда физические биндинги читают И обработчики строк (BlockRow,
// SlashEditor, BuilderScreen), И (с этапа 13.5) чипы-подсказки со шпаргалкой Cmd+/.
// Расхождение карты с поведением — баг: и то и другое смотрит в `chords` ниже.
//
// Все матчеры — по `e.code` (§3.1), а не `e.key`: физическая клавиша не зависит от
// раскладки. В кириллической раскладке `e.key` у Ctrl+Z равен 'я' — хоткей молча
// ломался (проект уже наступал). Исключение — символьные жесты («/» литералом,
// печатный seed): там важен произведённый символ, а не физическая клавиша, поэтому
// они остаются на `e.key` в самих обработчиках и в карту как биндинги не входят.

// KeyLike — структурный минимум клавиатурного события: `e.code` плюс модификаторы.
// Подходит и React-SyntheticEvent, и нативному KeyboardEvent, и объекту из теста.
export interface KeyLike {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

// mod — Cmd на маке / Ctrl на остальных: командный модификатор трактуем едино.
const mod = (e: KeyLike) => e.metaKey || e.ctrlKey
const vertArrow = (e: KeyLike) => e.code === 'ArrowUp' || e.code === 'ArrowDown'

// arrowDir — направление по вертикальной стрелке; общий хелпер для moveBlock/
// moveGroup/moveOption и обхода строк, чтобы 'up'/'down' выводились в одном месте.
export function arrowDir(e: KeyLike): 'up' | 'down' {
  return e.code === 'ArrowUp' ? 'up' : 'down'
}

// chords — предикаты физических комбинаций. Обработчики читают их вместо инлайновых
// `e.code === …`. Комбо с модификаторами (actionMenu/deleteBlock/answerAction/
// moveGroup/moveItem) обязаны проверяться ДО «голых» клавиш (enter/backspace/arrow*):
// голые матчеры модификаторы не исключают — порядок разводит их так же, как раньше
// разводила цепочка if-else (поведение при рефакторинге сохранено байт в байт).
export const chords = {
  // Cmd/Ctrl+.  — меню действий блока (§3.3). Period по e.code, в браузерах не занят.
  actionMenu: (e: KeyLike) => mod(e) && e.code === 'Period',
  // Cmd/Ctrl+Shift+Backspace — явное удаление блока/группы + тост (§3.4).
  deleteBlock: (e: KeyLike) => mod(e) && e.shiftKey && e.code === 'Backspace',
  // Cmd/Ctrl+Enter — действие над ответом/объектом (§3.2).
  answerAction: (e: KeyLike) => mod(e) && e.code === 'Enter',
  // Alt+Shift+↑/↓ — перенос группы целиком (§3.2).
  moveGroup: (e: KeyLike) => e.altKey && e.shiftKey && vertArrow(e),
  // Alt+↑/↓ — перенос блока/варианта (§3.2). Проверяется после moveGroup.
  moveItem: (e: KeyLike) => e.altKey && vertArrow(e),
  // Enter — новый блок/вариант; Shift+Enter (внутрь группы) отличают по e.shiftKey
  // в обработчике. Проверяется после answerAction (Cmd+Enter — тоже code 'Enter').
  enter: (e: KeyLike) => e.code === 'Enter',
  // Backspace — схлопывание/удаление объекта/варианта. Проверяется после deleteBlock.
  backspace: (e: KeyLike) => e.code === 'Backspace',
  arrowUp: (e: KeyLike) => e.code === 'ArrowUp',
  arrowDown: (e: KeyLike) => e.code === 'ArrowDown',
  escape: (e: KeyLike) => e.code === 'Escape',
  // Cmd/Ctrl+Z — undo; Cmd/Ctrl+Shift+Z и Ctrl+Y — redo (документ-уровень, §3.2).
  undo: (e: KeyLike) => mod(e) && !e.shiftKey && e.code === 'KeyZ',
  redo: (e: KeyLike) => mod(e) && ((e.shiftKey && e.code === 'KeyZ') || e.code === 'KeyY'),
} satisfies Record<string, (e: KeyLike) => boolean>

// ShortcutContext — поверхности полотна из таблиц §3.2. По этим ключам чипы-подсказки
// и шпаргалка (13.5) выбирают, что показать у сфокусированной строки.
export type ShortcutContext = 'text' | 'option' | 'object' | 'field' | 'title' | 'canvas'

// Shortcut — строка карты: физический биндинг (`match` из chords) + как его рисовать
// (`label`) + что он делает (`hint`). Единый источник для кода и UI подсказок.
export interface Shortcut {
  label: string
  hint: string
  match: (e: KeyLike) => boolean
}

const sc = (match: (e: KeyLike) => boolean, label: string, hint: string): Shortcut => ({
  match,
  label,
  hint,
})

// SHORTCUTS — карта «контекст × клавиша × действие × подсказка». Порядок в списке =
// приоритет показа в чипах (первым — самый релевантный действию строки). Матчеры —
// те же chords, что читают обработчики: одна карта на код и на подсказки.
export const SHORTCUTS: Record<ShortcutContext, Shortcut[]> = {
  text: [
    sc(chords.enter, 'Enter', 'Новый блок после группы'),
    sc((e) => chords.enter(e) && e.shiftKey, 'Shift+Enter', 'Новый блок внутрь группы'),
    sc(chords.answerAction, 'Cmd+Enter', 'К контролу ответа'),
    sc(chords.moveItem, 'Alt+↑↓', 'Переместить блок'),
    sc(chords.moveGroup, 'Alt+Shift+↑↓', 'Переместить группу'),
    sc(chords.deleteBlock, 'Cmd+Shift+⌫', 'Удалить блок'),
    sc(chords.actionMenu, 'Cmd+.', 'Меню действий'),
  ],
  option: [
    sc(chords.enter, 'Enter', 'Новый вариант'),
    sc(chords.moveItem, 'Alt+↑↓', 'Переместить вариант'),
    sc(chords.deleteBlock, 'Cmd+Shift+⌫', 'Удалить вопрос'),
    sc(chords.actionMenu, 'Cmd+.', 'Меню действий'),
  ],
  object: [
    sc(chords.answerAction, 'Cmd+Enter', 'Действие над объектом'),
    sc(chords.enter, 'Enter', 'Новый блок ниже'),
    sc(chords.backspace, '⌫', 'Удалить объект'),
    sc(chords.moveItem, 'Alt+↑↓', 'Переместить блок'),
    sc(chords.moveGroup, 'Alt+Shift+↑↓', 'Переместить группу'),
    sc(chords.deleteBlock, 'Cmd+Shift+⌫', 'Удалить блок'),
    sc(chords.actionMenu, 'Cmd+.', 'Меню действий'),
  ],
  field: [
    sc(chords.deleteBlock, 'Cmd+Shift+⌫', 'Удалить вопрос'),
    sc(chords.actionMenu, 'Cmd+.', 'Меню действий'),
  ],
  title: [sc(chords.enter, 'Enter', 'К первому блоку')],
  canvas: [sc(chords.enter, 'Enter', 'Начать')],
}
