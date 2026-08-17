import { packOptionRows, type Row } from '@fields/groups'

import { type Box, type DropTarget, pickDropTarget, pickHoverGroup, type Unit } from './dropTarget'

// ПРАВИЛА ЖЕСТА У СПИСКА ВАРИАНТОВ. Прицеливание и полосы — общие с полотном
// (`dropTarget.ts`), здесь только перевод: вариант — ЕДИНИЦА слоя, часть у неё одна, она
// сама. Внутренних рядов у варианта нет, поэтому `inner` слой не даёт вовсе.
//
// Модуль чистый и со своим тестом по той же причине, что `dropTarget.ts` и `rowZones.ts`:
// жест проверяется мышью, в vitest он не воспроизводится, и без сторожа правила ломались
// бы правкой соседнего кода молча.

export type OptionRef = { id: string; column?: number }

// Раскладка списка в терминах прицела. Тот же `packOptionRows`, что рисует список у
// респондента: своё представление о рядах здесь разошлось бы с картинкой — это и был
// дефект «помечен half — нарисован full» на полотне.
//
// Считается ВНЕ кадра драга (мемо у списка): прицел зовётся на каждое движение указателя,
// и пересборка единиц 60 раз в секунду была бы мусором на длинном списке (§5.3).
export function optionUnits<T extends OptionRef>(options: T[]): Row<Unit>[] {
  return packOptionRows(options).map((row) => row.map((cell) => cell.map(unitOf)))
}

const unitOf = (o: OptionRef): Unit => ({ id: o.id, blocks: [{ id: o.id }] })

// Цель дропа: элемент под указателем, линия всегда ПОД ним (§5.2). Слой — 'unit': у
// варианта нет частей, которые целями работают отдельно.
export function pickOptionTarget(
  rows: Row<Unit>[],
  boxes: Map<string, Box>,
  pointer: { x: number; y: number },
  activeId: string,
): DropTarget | null {
  return pickDropTarget(rows, boxes, pointer, { layer: 'unit', activeId })
}

// Вариант, НАД КОТОРЫМ указатель, — второй ответ жеста, от цели намеренно отдельный
// (§5.1): у цели якорь хвост ряда, и приглашение «встань в ряд», взятое от неё,
// загоралось бы только у последнего варианта.
export function pickHoverOption(
  rows: Row<Unit>[],
  boxes: Map<string, Box>,
  pointer: { x: number; y: number },
  activeId: string,
): string | null {
  return pickHoverGroup(rows, boxes, pointer, { layer: 'unit', activeId })
}

// inviteOptionRowId — ряд, у которого горит приглашение, и его АДРЕС. Ряд РОВНО ОДИН:
// тот, над которым указатель (как у полотна, rowZones.ts). Адрес — любой участник ряда,
// КРОМЕ перетаскиваемого: адрес уезжает целью в `placeOptionInRow`, а та первой же
// строкой выходит на `active === target`, и перенос между колонками СВОЕЙ секции молча
// стал бы no-op'ом — полоса горит, автор отпускает, не происходит ничего.
//
// Отказ здесь ровно один — ряд, в котором стоит только сам перетаскиваемый вариант:
// паре не с кем, адреса, отличного от активного, в таком ряду просто нет. Второго отказа
// (у полотна это `groupCanPair`) у списка не бывает: карточка варианта делит ряд всегда.
export function inviteOptionRowId(
  rows: Row<Unit>[],
  nearId: string | null,
  activeId: string,
): string | null {
  if (nearId === null) return null
  const row = rows.find((r) => r.some((cell) => cell.some((u) => u.id === nearId)))
  if (!row) return null
  return row.flat().find((u) => u.id !== activeId)?.id ?? null
}

// Зоны жеста списка — отдельный вид droppable'а, и пространство id у него СВОЁ: id
// варианта и id зоны попадают в один фильтр коллизий, и путать их нельзя. Смысл полей —
// тот же, что у зоны ряда на полотне: геометрия называет команду, вертикальная полоса на
// границе колонок открывает новую колонку (insert), горизонтальная в подвале колонки
// кладёт вариант в её стопку.
const OPT_ZONE = 'optzone:'
export type OptionZone = { optionId: string; col: number; insert: boolean }
export const optionZoneId = (rowId: string, col: number, insert: boolean) =>
  `${OPT_ZONE}${insert ? 'b' : 'c'}${col}:${rowId}`
export const optionZoneTarget = (id: string | number): OptionZone | null => {
  const s = String(id)
  if (!s.startsWith(OPT_ZONE)) return null
  const rest = s.slice(OPT_ZONE.length)
  const at = rest.indexOf(':')
  return { insert: rest[0] === 'b', col: Number(rest.slice(1, at)), optionId: rest.slice(at + 1) }
}
