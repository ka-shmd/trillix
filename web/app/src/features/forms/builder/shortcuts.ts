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

import { type Mark } from '@entities/formSchema'

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
  // Mod+Alt+→ / Mod+Alt+← — перенос в правую ячейку ряда и обратно (§5): клавиатурное
  // зеркало жеста, команда ПЕРЕНОСА, а не переключатель режима. Именно Mod+Alt, а не
  // Alt: Alt+←/→ и Alt+Shift+←/→ заняты навигацией и выделением по словам внутри текста.
  rowRight: (e: KeyLike) => mod(e) && e.altKey && e.code === 'ArrowRight',
  rowLeft: (e: KeyLike) => mod(e) && e.altKey && e.code === 'ArrowLeft',
  // Enter — новый блок/вариант; Shift+Enter (внутрь группы) отличают по e.shiftKey
  // в обработчике. Проверяется после answerAction (Cmd+Enter — тоже code 'Enter').
  enter: (e: KeyLike) => e.code === 'Enter',
  // Backspace — схлопывание/удаление объекта/варианта. Проверяется после deleteBlock.
  backspace: (e: KeyLike) => e.code === 'Backspace',
  arrowUp: (e: KeyLike) => e.code === 'ArrowUp',
  arrowDown: (e: KeyLike) => e.code === 'ArrowDown',
  escape: (e: KeyLike) => e.code === 'Escape',
  // Cmd/Ctrl+/ — шпаргалка по клавишам текущего контекста (§7). Slash по e.code:
  // в кириллической раскладке та же физическая клавиша даёт «.», а не «/».
  cheatSheet: (e: KeyLike) => mod(e) && e.code === 'Slash',
  // Cmd/Ctrl+Z — undo; Cmd/Ctrl+Shift+Z и Ctrl+Y — redo (документ-уровень, §3.2).
  undo: (e: KeyLike) => mod(e) && !e.shiftKey && e.code === 'KeyZ',
  redo: (e: KeyLike) => mod(e) && ((e.shiftKey && e.code === 'KeyZ') || e.code === 'KeyY'),
  // Богатый текст (фаза 14, §3.3 `DESIGN-rich-text.md`). В карту ПОДСКАЗОК пункты
  // приезжают этапом 14.4 вместе с панелью — здесь пока только матчеры, и это не
  // нарушает «подсказка не имеет права врать»: обещать неработающее нельзя, не
  // обещать работающее — можно.
  //
  // Mod+B/I/U обязаны гаситься ЯВНО (и с остановкой всплытия): внутри contenteditable
  // их обрабатывает сам браузер и вставляет собственные теги мимо нашей модели, а
  // Mod+B вдобавок занят вендоренным сайдбаром shadcn (слушатель на window).
  bold: (e: KeyLike) => mod(e) && !e.shiftKey && e.code === 'KeyB',
  italic: (e: KeyLike) => mod(e) && !e.shiftKey && e.code === 'KeyI',
  underline: (e: KeyLike) => mod(e) && !e.shiftKey && e.code === 'KeyU',
  // Зачёркивание — на Shift: голый Mod+S занят «сохранить» у браузера и означал бы
  // диалог сохранения страницы посреди набора.
  strike: (e: KeyLike) => mod(e) && e.shiftKey && e.code === 'KeyS',
  // Mod+K — ссылка на выделении. Значимая марка, но аккорд у неё есть: он открывает
  // поле адреса, а не применяет значение вслепую (в отличие от цветов, у которых вход
  // только через панель).
  link: (e: KeyLike) => mod(e) && !e.shiftKey && e.code === 'KeyK',
} satisfies Record<string, (e: KeyLike) => boolean>

// markChord — аккорд → булева марка, одной таблицей. Отдельная функция, а не цепочка
// if в обработчике строки: добавление марки обязано стоить одну строку здесь и одну в
// `MARKS` (§1 спеки), а не правку потока клавиш.
//
// Значимым маркам (цвет, фон, ссылка) аккорда не даём: у них есть значение, и «открыть
// выборщик» шорткатом — жест без результата. Их вход — панель этапа 14.4.
const MARK_CHORDS: ReadonlyArray<[(e: KeyLike) => boolean, Mark]> = [
  [chords.bold, 'b'],
  [chords.italic, 'i'],
  [chords.underline, 'u'],
  [chords.strike, 's'],
]

export function markChord(e: KeyLike): Mark | null {
  for (const [match, mark] of MARK_CHORDS) if (match(e)) return mark
  return null
}

// ShortcutContext — поверхности полотна из таблиц §3.2. По этим ключам чипы-подсказки
// и шпаргалка (13.5) выбирают, что показать у сфокусированной строки. Объект расщеплён
// надвое: у картинки Cmd+Enter открывает файловый диалог, а у date/scale открывать
// нечего — один общий контекст обещал бы клавишу, которой там нет (решение владельца
// 2026-07-25: подсказка, которая врёт, хуже отсутствующей).
export type ShortcutContext =
  | 'text'
  | 'option'
  // Пустая строка в конце списка вариантов («призрак»): вариантом ещё не является,
  // поэтому клавиши варианта на ней не работают и обещать их нельзя — свой контекст.
  | 'newOption'
  | 'field'
  | 'image'
  | 'object'
  | 'title'
  | 'canvas'

// Shortcut — строка карты: как его рисовать (`label`), что он делает (`hint`) и —
// если это биндинг — каким предикатом он ловится (`match` из chords).
//
// `match` необязателен намеренно: часть жестов §3.2 символьная («/», печатный символ,
// вставка) и ловится по произведённому символу, а не по физической клавише (см. шапку
// файла). Показывать их надо — матчера у них нет. Пункт без `match` существует только
// для подсказок; обработчики читают `chords` напрямую и о нём не знают.
export interface Shortcut {
  label: string
  hint: string
  // short — та же мысль в размер чипа. Чипы стоят справа В СТРОКЕ, места там столько,
  // сколько не занял текст, и полное `hint` («Новый блок после вопроса») ложится на
  // подпись. Шпаргалке место не жмёт — она печатает `hint`, где важна точность
  // (Enter «после вопроса» против Shift+Enter «внутрь вопроса»). Нет short — чип
  // берёт hint.
  short?: string
  match?: (e: KeyLike) => boolean
}

const sc = (
  match: (e: KeyLike) => boolean,
  label: string,
  hint: string,
  short?: string,
): Shortcut => ({ match, label, hint, short })

// gesture — пункт карты без матчера: символьный жест (см. Shortcut.match).
const gesture = (label: string, hint: string, short?: string): Shortcut => ({
  label,
  hint,
  short,
})

// chipText — что печатает чип у сфокусированной строки.
export const chipText = (s: Shortcut): string => s.short ?? s.hint

// В `label` командный модификатор пишется словом `Mod` — на маке он рисуется как ⌘,
// на остальных как Ctrl. Подстановку делает UI подсказок (`modLabel` ниже), а не карта:
// карта не знает, на чём её читают.
export const MOD_TOKEN = 'Mod'

// GLOBAL — работает на всём экране билдера независимо от того, где каретка: слушатель
// висит на окне (BuilderScreen). Исключение — название формы: там undo нативный
// (data-undo-native), документ-уровень его не перехватывает, поэтому в контексте
// 'title' этот ярус не показывается (см. commonFor).
export const GLOBAL: Shortcut[] = [
  sc(chords.undo, 'Mod+Z', 'Отменить'),
  sc(chords.redo, 'Mod+Shift+Z', 'Вернуть'),
  sc(chords.cheatSheet, 'Mod+/', 'Все горячие клавиши'),
]

// BLOCK_COMMON — общий ярус блочных контекстов: клавиши с ОДНИМ смыслом на всех
// поверхностях строки (текст, вариант, поле, объект). У сфокусированной строки они не
// показываются (иначе чипы одинаковы везде и перестают читаться) — их место в
// шпаргалке Mod+/ (решение владельца 2026-07-25).
//
// Список короткий не по лени: Alt+↑↓ и Alt+Shift+↑↓ сюда НЕ входят, потому что делают
// разное. В варианте Alt+↑↓ двигает вариант, а Alt+Shift+↑↓ (обработчик вариантов
// moveGroup не проверяет) — тоже вариант, а не группу; в инпуте плейсхолдера ни то ни
// другое не работает вовсе. Поэтому переносы живут в контекстных списках, каждый со
// своей формулировкой.
export const BLOCK_COMMON: Shortcut[] = [
  sc(chords.actionMenu, 'Mod+.', 'Меню действий блока'),
  sc(chords.deleteBlock, 'Mod+Shift+⌫', 'Удалить блок (на подписи — вопрос целиком)'),
  sc((e) => chords.arrowUp(e) || chords.arrowDown(e), '↑↓', 'По строкам полотна'),
]

// SHORTCUTS — контекстная часть карты: только то, что специфично поверхности. Порядок
// в списке = приоритет показа в чипах (первым — самый релевантный действию строки),
// шпаргалка печатает список целиком. Матчеры — те же chords, что читают обработчики:
// одна карта на код и на подсказки, расхождение = баг (демо-критерий 13.5).
export const SHORTCUTS: Record<ShortcutContext, Shortcut[]> = {
  text: [
    sc(chords.enter, 'Enter', 'Новый блок после вопроса', 'Новый блок'),
    gesture('/', 'Вставить поле или заголовок', 'Поле'),
    // Cmd+Enter из подписи прыгает к контролу ответа своей группы — и только если он
    // там есть: в одиночном абзаце handleAnswerAction ничего не находит и молчит.
    // Поэтому пункт условный, см. shortcutsFor({ hasAnswer }).
    sc(chords.answerAction, 'Mod+Enter', 'К полю ответа', 'К полю'),
    sc((e) => chords.enter(e) && e.shiftKey, 'Shift+Enter', 'Новый блок внутрь вопроса'),
    sc(chords.moveItem, 'Alt+↑↓', 'Переместить блок'),
    sc(chords.moveGroup, 'Alt+Shift+↑↓', 'Переместить вопрос'),
    sc(chords.rowRight, 'Mod+Alt+→', 'В ряд с предыдущим вопросом', 'В ряд'),
    sc(chords.rowLeft, 'Mod+Alt+←', 'Вернуть своим рядом', 'Свой ряд'),
    gesture('⌫ в начале', 'Склеить с предыдущей строкой'),
    // Богатый текст (фаза 14). Формулировка «на выделении» обязательна: со схлопнутой
    // кареткой аккорд молчит, и подсказка без этого слова врала бы — тот же случай,
    // что у условного Mod+Enter выше. Стоят в конце списка: чипы берут его начало,
    // шпаргалка печатает целиком, а форматирование — не то, ради чего строка нужна.
    sc(chords.bold, 'Mod+B', 'Жирный (на выделении)'),
    sc(chords.italic, 'Mod+I', 'Курсив (на выделении)'),
    sc(chords.underline, 'Mod+U', 'Подчёркнутый (на выделении)'),
    sc(chords.strike, 'Mod+Shift+S', 'Зачёркнутый (на выделении)'),
    sc(chords.link, 'Mod+K', 'Ссылка (на выделении)'),
    gesture('выделить текст', 'Панель форматирования: цвет, фон, ссылка'),
  ],
  option: [
    sc(chords.enter, 'Enter', 'Новый вариант ниже', 'Новый вариант'),
    gesture('⌫ в пустом', 'Удалить вариант', 'Удалить'),
    sc(chords.moveItem, 'Alt+↑↓', 'Переместить вариант', 'Переместить'),
    sc(chords.rowRight, 'Mod+Alt+→', 'В ряд с предыдущим вариантом', 'В ряд'),
    sc(chords.rowLeft, 'Mod+Alt+←', 'Вернуть своим рядом', 'Свой ряд'),
    // Длинные подписи — в чипы такие пункты не влезают, поэтому стоят после трёх
    // коротких: чипы берут начало списка, шпаргалка печатает его целиком.
    gesture('Enter в пустом последнем', 'Выйти из списка'),
    // Cmd+Enter в варианте — тоже новый вариант: обработчик списка ловит его тем же
    // chords.enter (Cmd+Enter — это code 'Enter'), и §3.2 называет это единым жестом
    // «действие над ответом». Работает — значит, в карте быть обязано.
    sc(chords.answerAction, 'Mod+Enter', 'Новый вариант ниже'),
  ],
  // newOption — «призрак» в конце списка: пустая строка, которая вариантом станет,
  // как только в неё что-то напишут. Клавиш у неё почти нет намеренно — она и есть
  // одна клавиша: набери текст. ⌫ показываем только словами «удалить блок», потому
  // что удалять в самом призраке нечего.
  newOption: [
    gesture('любой символ', 'Добавить вариант', 'Вариант'),
    gesture('⌫ в пустом', 'Удалить блок, если вариантов нет', 'Удалить блок'),
  ],
  // field — инпут текста-подсказки под вопросом. Клавиш у него почти нет намеренно:
  // это необязательный лист (§2.1), Enter и вертикальные переносы там не обрабатываются.
  // Исключение — ряд: у ГОЛОГО поля (без подписи) это единственная поверхность, и без
  // Mod+Alt+←/→ здесь сборка ряда без мыши для него была бы невозможна.
  field: [
    gesture('⌫ в пустом', 'Удалить поле', 'Удалить'),
    sc(chords.rowRight, 'Mod+Alt+→', 'В ряд с предыдущим вопросом', 'В ряд'),
    sc(chords.rowLeft, 'Mod+Alt+←', 'Вернуть своим рядом', 'Свой ряд'),
  ],
  // На объектной остановке (image/date/scale) печатный символ засевает текстовую
  // строку НИЖЕ, а «/» — строку с открытым меню типов: два разных жеста, и «любой
  // символ» без отдельной строки про «/» обещал бы за него неправду.
  image: [
    sc(chords.answerAction, 'Mod+Enter', 'Выбрать файл'),
    sc(chords.backspace, '⌫', 'Удалить картинку', 'Удалить'),
    sc(chords.enter, 'Enter', 'Новый блок ниже', 'Новый блок'),
    sc(chords.moveItem, 'Alt+↑↓', 'Переместить блок'),
    sc(chords.moveGroup, 'Alt+Shift+↑↓', 'Переместить вопрос'),
    sc(chords.rowRight, 'Mod+Alt+→', 'В ряд с предыдущим вопросом', 'В ряд'),
    sc(chords.rowLeft, 'Mod+Alt+←', 'Вернуть своим рядом', 'Свой ряд'),
    gesture('/', 'Вставить блок ниже'),
    gesture('любой символ', 'Начать текст ниже'),
  ],
  object: [
    sc(chords.backspace, '⌫', 'Удалить блок', 'Удалить'),
    sc(chords.enter, 'Enter', 'Новый блок ниже', 'Новый блок'),
    gesture('любой символ', 'Начать текст ниже', 'Текст ниже'),
    sc(chords.moveItem, 'Alt+↑↓', 'Переместить блок'),
    sc(chords.moveGroup, 'Alt+Shift+↑↓', 'Переместить вопрос'),
    sc(chords.rowRight, 'Mod+Alt+→', 'В ряд с предыдущим вопросом', 'В ряд'),
    sc(chords.rowLeft, 'Mod+Alt+←', 'Вернуть своим рядом', 'Свой ряд'),
    gesture('/', 'Вставить блок ниже'),
  ],
  title: [sc((e) => chords.enter(e) || chords.arrowDown(e), 'Enter / ↓', 'К первому блоку')],
  canvas: [
    sc(chords.enter, 'Enter', 'Начать'),
    gesture('/', 'Выбрать тип блока'),
    gesture('любой символ', 'Начать текст'),
  ],
}

// BLOCK_CONTEXTS — поверхности строк блока: у них есть общий ярус BLOCK_COMMON.
// Название формы и пустое полотно — не строки блока: меню действий и удаление блока
// там не работают.
const BLOCK_CONTEXTS: ReadonlySet<ShortcutContext> = new Set<ShortcutContext>([
  'text',
  'option',
  'newOption',
  'field',
  'image',
  'object',
])

// shortcutsFor — контекстные пункты строки (для чипов и верхней части шпаргалки).
// hasAnswer — есть ли в группе строки отвечаемый блок; без него Mod+Enter выпадает:
// прыгать не к чему, а обещать клавишу, которая молчит, нельзя.
// movesRow — двигает ли Alt+↑↓ именно ЭТУ строку. Ложь в двух случаях, и в обоих
// пункт «Переместить блок» выпадает: у строки ответа в озаглавленной группе жест
// не делает ничего (вопрос двигают с подписи), а на самой подписи он двигает вопрос
// целиком — то есть обещал бы не то, что делает. Перенос вопроса остаётся обещан
// отдельным пунктом (Alt+Shift+↑↓).
export function shortcutsFor(
  ctx: ShortcutContext,
  opts: { hasAnswer?: boolean; movesRow?: boolean } = {},
): Shortcut[] {
  let list = SHORTCUTS[ctx]
  if (opts.movesRow === false) list = list.filter((s) => s.match !== chords.moveItem)
  if (ctx !== 'text' || opts.hasAnswer) return list
  return list.filter((s) => s.match !== chords.answerAction)
}

// commonFor — общие пункты, применимые к контексту (нижняя часть шпаргалки). У строк
// блока это BLOCK_COMMON + GLOBAL; у пустого полотна — только GLOBAL; у названия формы
// — только сама шпаргалка (undo там нативный, блочных клавиш нет).
export function commonFor(ctx: ShortcutContext): Shortcut[] {
  if (BLOCK_CONTEXTS.has(ctx)) return [...BLOCK_COMMON, ...GLOBAL]
  if (ctx === 'title') return GLOBAL.filter((s) => s.match === chords.cheatSheet)
  return GLOBAL
}

// modLabel — как показать командный модификатор на этой машине. Мак печатает ⌘,
// остальные — Ctrl. Определяем по userAgent (navigator.platform устарел), в не-браузер-
// ном окружении (node-тесты) считаем не-маком.
export function modLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return /Mac|iPhone|iPad/.test(ua) ? '⌘' : 'Ctrl'
}

// formatLabel — подстановка модификатора в `label` карты перед показом.
export function formatLabel(label: string): string {
  return label.replaceAll(MOD_TOKEN, modLabel())
}
