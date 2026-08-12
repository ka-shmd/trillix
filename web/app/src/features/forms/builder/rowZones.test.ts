import { describe, expect, it } from 'vitest'

import { type Block, textFromString } from '@entities/formSchema'
import { groupBlocks, packRows } from '@fields/groups'

import { inviteRowId } from './rowZones'

// Правила приглашения «встань в ряд» (решение владельца 2026-08-02). Сам жест —
// перетаскивание мышью, и в vitest он не воспроизводится; поэтому проверяются два
// решение, которое жест принимает ДО всякой геометрии: у какого ряда гореть зоне.
// Функция чистая, над раскладкой, и молча ломалась бы правкой соседнего кода.

let seq = 0
const blk = (type: Block['type'], extra: Partial<Block> = {}): Block => ({
  id: `b${++seq}`,
  type,
  groupId: `g${seq}`,
  text: textFromString(''),
  required: false,
  ...extra,
})

// Раскладка из плоского списка — тем же раскладчиком, что рисует полотно: тест обязан
// спрашивать у него, а не повторять его правила своими руками.
const layout = (blocks: Block[]) => packRows(groupBlocks(blocks))

describe('inviteRowId', () => {
  it('называет ряд БЛИЖАЙШЕЙ группы, а не первый подходящий', () => {
    const a = blk('short_text')
    const b = blk('email')
    const c = blk('text')
    const rows = layout([a, b, c])

    expect(inviteRowId(rows, b.groupId, c.groupId)).toBe(b.groupId)
    expect(inviteRowId(rows, a.groupId, c.groupId)).toBe(a.groupId)
  })

  it('молчит без перетаскиваемого кандидата и без ближайшей группы', () => {
    const a = blk('short_text')
    const rows = layout([a, blk('email')])

    expect(inviteRowId(rows, a.groupId, null)).toBeNull()
    expect(inviteRowId(rows, null, a.groupId)).toBeNull()
  })

  it('не приглашает ряд, в котором стоит только сам перетаскиваемый вопрос', () => {
    const a = blk('short_text')
    const rows = layout([a, blk('email')])

    expect(inviteRowId(rows, a.groupId, a.groupId)).toBeNull()
  })

  // Адрес уезжает целью в placeInRow, а та выходит по active === target. С адресом
  // «первая группа ряда» перенос между колонками СВОЕЙ секции (стою слева, тяну
  // вправо) молча становился бы no-op'ом: зона горит, а дроп не делает ничего.
  // Найдено ревью.
  it('адресует ряд участником, ОТЛИЧНЫМ от перетаскиваемого', () => {
    const left = blk('short_text')
    const right = blk('email', { settings: { column: 2 } })
    const rows = layout([left, right])

    expect(rows[0]).toHaveLength(2)
    expect(inviteRowId(rows, left.groupId, left.groupId)).toBe(right.groupId)
    expect(inviteRowId(rows, right.groupId, right.groupId)).toBe(left.groupId)
  })

  // Найдено ревью фазы 19. Разрыв страницы стал вторым типом с canShareRow: false, но,
  // в отличие от заголовка формы, он остаётся в раскладке (он граница и обязан закрывать
  // секцию). Приглашение спрашивало только про внутренний ряд — и загоралось на разрыве,
  // хотя placeInRow такой дроп отвергает: жест, который убедительно ничего не делает.
  it('не приглашает разрыв страницы: ряд с ним невозможен', () => {
    const before = blk('short_text')
    const brk = blk('page_break')
    const other = blk('email')
    const rows = layout([before, brk, other])

    expect(inviteRowId(rows, brk.groupId, other.groupId)).toBeNull()
    // Соседи разрыва между собой приглашение по-прежнему показывают.
    expect(inviteRowId(rows, before.groupId, other.groupId)).toBe(before.groupId)
  })

  it('не приглашает вопрос с внутренним рядом: он занимает всю ширину (§6.5)', () => {
    // Мульти-группа «подпись | поле», собранная в ряд ВНУТРИ вопроса: подпись несёт
    // бит, поле стоит справа от неё. groupCanShareRow для такой группы ложен, и
    // placeInRow дроп отверг бы — приглашать нельзя.
    const gid = 'q'
    const caption = blk('title', { groupId: gid })
    const field = blk('short_text', { groupId: gid, settings: { column: 2 } })
    const other = blk('email')
    const rows = layout([caption, field, other])
    const near = rows[0]![0]![0]!.id

    expect(inviteRowId(rows, near, other.groupId)).toBeNull()
    // А обычный полноширинный сосед приглашение показывает.
    expect(inviteRowId(rows, other.groupId, caption.groupId)).toBe(other.groupId)
  })

  it('секция приглашает обеими сторонами — в неё кладут ТРЕТИЙ элемент', () => {
    const left = blk('short_text')
    const right = blk('email', { settings: { column: 2 } })
    const active = blk('text')
    const rows = layout([left, right, active])

    expect(rows[0]).toHaveLength(2)
    expect(inviteRowId(rows, right.groupId, active.groupId)).toBe(left.groupId)
  })
})
