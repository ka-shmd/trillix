import { describe, expect, it } from 'vitest'
import type { Block } from '@entities/formSchema'
import { isFlowLeaf, stopNeighbor } from './navigation'

// Хелпер сборки блока: тип + группа, остальное по вкусу теста.
function blk(id: string, groupId: string, type: Block['type']): Block {
  return { id, groupId, type }
}

// Вопрос с подписью: [подпись | поле]. Поле — лист (поток его перескакивает).
const captioned = [blk('c1', 'g1', 'label'), blk('f1', 'g1', 'short_text')]
// Голое поле (группа без подписи) — НЕ лист, обычная остановка.
const bare = [blk('f2', 'g2', 'email')]

describe('isFlowLeaf — что поток перескакивает', () => {
  it('инпут плейсхолдера с подписью — лист', () => {
    expect(isFlowLeaf(captioned, captioned[1]!)).toBe(true)
  })

  it('голое поле (без подписи) — не лист', () => {
    expect(isFlowLeaf(bare, bare[0]!)).toBe(false)
  })

  it('подпись, контент, объект — не листы', () => {
    const blocks = [
      blk('c', 'g1', 'label'),
      blk('h', 'g2', 'heading'),
      blk('img', 'g3', 'image'),
      blk('sc', 'g4', 'scale'),
    ]
    for (const b of blocks) expect(isFlowLeaf(blocks, b), b.type).toBe(false)
  })
})

describe('stopNeighbor — обход с перескоком листов', () => {
  // Две группы с подписью подряд: [c1 f1 c2 f2].
  const twoQuestions = [
    blk('c1', 'g1', 'label'),
    blk('f1', 'g1', 'short_text'),
    blk('c2', 'g2', 'label'),
    blk('f2', 'g2', 'email'),
  ]

  it('вниз с подписи — перескок своего поля на следующую подпись', () => {
    expect(stopNeighbor(twoQuestions, 0, 'down')?.id).toBe('c2')
  })

  it('вверх со второй подписи — перескок чужого поля на первую подпись', () => {
    expect(stopNeighbor(twoQuestions, 2, 'up')?.id).toBe('c1')
  })

  it('вверх из поля — на свою подпись (подпись не перескакивается)', () => {
    expect(stopNeighbor(twoQuestions, 1, 'up')?.id).toBe('c1')
  })

  it('край полотна — undefined', () => {
    expect(stopNeighbor(twoQuestions, 0, 'up')).toBeUndefined()
    expect(stopNeighbor(twoQuestions, 3, 'down')).toBeUndefined()
  })

  it('голое поле не перескакивается — остаётся достижимым', () => {
    // [c1 f1 bf]: с подписи вниз перескок f1, но голое bf — остановка.
    const withBare = [
      blk('c1', 'g1', 'label'),
      blk('f1', 'g1', 'short_text'),
      blk('bf', 'g3', 'email'),
    ]
    expect(stopNeighbor(withBare, 0, 'down')?.id).toBe('bf')
  })
})
