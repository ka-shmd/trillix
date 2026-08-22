import { arrowDir, chords, type KeyLike } from './shortcuts'

// Контракт клавиатуры ПОВЕРХНОСТИ строки (фаза 16, этап 16.6; спека §3.3).
//
// Цепочка аккордов у полотна одна, а поверхностей четыре — текст (подписи, контент,
// согласие), плейсхолдер, список вариантов и объектная остановка (картинка, дата,
// шкала). До этого этапа цепочка была написана в каждой по 7–9 ветвей `else if`, и
// новый тип со своей поверхностью получал пятую копию. Копии не сводились «в одну
// функцию» механически: различия между ними настоящие (уходит ли стрелка со строки,
// что значит Backspace, куда идёт печатный символ) — поэтому здесь не общая
// реализация, а общий ПОРЯДОК с точками доопределения.
//
// Что даёт вынос — ровно одно, и это главное: **порядок проверок перестал быть
// устной традицией**. Он не косметика, а корректность: `answerAction` (Mod+Enter)
// обязан идти до `enter`, `moveGroup` (Alt+Shift+↑↓) — до `moveItem` (Alt+↑↓), а тот
// — до голых стрелок, потому что голые матчеры модификаторы не исключают. Каждая
// копия выводила этот порядок заново, и одна уже носила рукописную заплату
// (`!chords.moveGroup(e)` в плейсхолдере) — след того, что вывела неточно.
//
// Чего здесь НЕТ и не будет: знания о блоках, группах и сторе. Поверхность получает
// событие и зовёт то, что ей передал владелец строки. Правила про пары и
// последовательности блоков (`regroup`, ряды, дроп, контракт фокуса) остаются в общем
// коде — §3.4 спеки.

export type ArrowDir = 'up' | 'down'
export type RowSide = 'left' | 'right'

// RowKeySpec — что поверхность умеет. Отсутствующий обработчик значит «этот аккорд
// поверхности не принадлежит»: событие уходит дальше по цепочке, а не молча гасится.
//
// Исключение одно и оно принципиальное — см. `moveGroup` ниже.
export interface RowKeySpec {
  // Mod+. — попап настроек блока.
  actionMenu?: () => void
  // Mod+Shift+Backspace — явное удаление блока (или группы, решает владелец строки).
  deleteBlock?: () => void
  // Mod+Enter — действие над ответом: у подписи это переход к контролу вопроса, у
  // картинки — файловый диалог, у варианта — новый вариант.
  answerAction?: () => void
  // Alt+Shift+↑↓ — перенос ГРУППЫ. Поверхность без этого обработчика аккорд ГЛУШИТ, а
  // не пропускает дальше: Alt+Shift+↑↓ не имеет права молча выродиться в Alt+↑↓
  // («перенести строку»), потому что карта клавиш обещает другое. Ровно это правило и
  // было той рукописной заплатой в плейсхолдере, ради которой цепочка сводится сюда.
  moveGroup?: (dir: ArrowDir) => void
  // Mod+Alt+←/→ — ряд из двух вопросов (или вариантов).
  rowShift?: (side: RowSide) => void
  // Alt+↑↓ — перенос самой строки (или варианта внутри списка).
  moveItem?: (dir: ArrowDir) => void
  // ↑↓ — уход на соседнюю строку. Условие ухода объявляет поверхность: у текста и
  // плейсхолдера стрелка уходит только с края каретки, у объекта — всегда, у списка
  // сперва ходит по вариантам. Guard вернул false — событие остаётся поверхности
  // (нативная навигация внутри текста).
  arrow?: (dir: ArrowDir) => void
  arrowLeaves?: (dir: ArrowDir) => boolean
  // Enter — новая строка/вариант ниже. Событие передаётся целиком: списку нужно
  // состояние текущего варианта. Shift сюда не доходит вовсе — `chords.enter` его
  // исключает, а перенос строки принадлежит тексту (RichLine).
  enter?: (e: KeyLike) => void
  // Backspace. Guard решает, её ли это Backspace: у текста — каретка в начале, у
  // плейсхолдера и варианта — пустое значение, у объекта — всегда.
  backspace?: () => void
  backspaceHandles?: () => boolean
  // «/» — открыть меню типов (у объектной остановки — на строке НИЖЕ, своей строки у
  // него нет). Отдельно от printable: символ тот же, а смысл другой.
  slash?: () => void
  // Печатный символ на поверхности, которая текста не несёт: объект засевает им
  // строку ниже. У текстовых поверхностей обработчика нет — символ идёт в них сам.
  printable?: (key: string) => void
}

// Событие клавиатуры в объёме, который нужен цепочке: аккорды читают `code` и
// модификаторы (KeyLike), ветви символов — `key`, гашение — preventDefault.
export interface RowKeyEvent extends KeyLike {
  key: string
  preventDefault: () => void
}

// handleRowKeys прогоняет событие по общей цепочке. Возвращает true, если событие
// обработано (и погашено) — владельцу строки это нужно, чтобы не продолжать свою
// логику после.
//
// Порядок ветвей ниже — тот самый контракт. Менять его можно только зная, какие пары
// аккордов пересекаются: голые enter/backspace/стрелки модификаторы НЕ исключают,
// поэтому комбо обязаны проверяться раньше.
export function handleRowKeys(e: RowKeyEvent, spec: RowKeySpec): boolean {
  const take = (fn: () => void): true => {
    e.preventDefault()
    fn()
    return true
  }

  if (chords.actionMenu(e)) return spec.actionMenu ? take(spec.actionMenu) : false
  if (chords.deleteBlock(e)) return spec.deleteBlock ? take(spec.deleteBlock) : false
  if (chords.answerAction(e)) return spec.answerAction ? take(spec.answerAction) : false

  // moveGroup — единственный аккорд, который цепочка глушит и без обработчика:
  // иначе он провалился бы в moveItem ниже (Alt+Shift+↑↓ подходит под Alt+↑↓) и
  // «перенести вопрос» молча означало бы «перенести строку». См. RowKeySpec.
  if (chords.moveGroup(e)) {
    if (!spec.moveGroup) return false
    return take(() => spec.moveGroup!(arrowDir(e)))
  }
  if (chords.rowRight(e) || chords.rowLeft(e)) {
    if (!spec.rowShift) return false
    return take(() => spec.rowShift!(chords.rowRight(e) ? 'right' : 'left'))
  }
  if (chords.moveItem(e)) {
    if (!spec.moveItem) return false
    return take(() => spec.moveItem!(arrowDir(e)))
  }

  if (chords.arrowUp(e) || chords.arrowDown(e)) {
    if (!spec.arrow) return false
    const dir = arrowDir(e)
    if (spec.arrowLeaves && !spec.arrowLeaves(dir)) return false
    return take(() => spec.arrow!(dir))
  }

  if (chords.enter(e)) return spec.enter ? take(() => spec.enter!(e)) : false

  if (chords.backspace(e)) {
    if (!spec.backspace) return false
    if (spec.backspaceHandles && !spec.backspaceHandles()) return false
    return take(spec.backspace)
  }

  // Символьные ветви — по `key`, а не по `code`: важен произведённый символ, а не
  // физическая клавиша (§3.1 shortcuts.ts). Печатный — последним: под него подходит
  // любой одиночный символ, включая «/».
  if (e.key === '/' && spec.slash) return take(spec.slash)
  if (spec.printable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const key = e.key
    return take(() => spec.printable!(key))
  }
  return false
}
