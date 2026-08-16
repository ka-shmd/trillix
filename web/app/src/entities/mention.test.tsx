// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { RichText } from '@fields/BlockField'
import { MentionContext, answerText, mentionResolver } from '@fields/mention'
import { planForm } from '@fields/logic'
import { type Block, type Span } from '@entities/formSchema'

// Подстановка ответов (docs/design/mentions.md). Как и у richText.test.tsx, тест живёт
// в кабинете, а проверяет код из web/shared: DOM-окружение узаконено только здесь.
//
// Главное, что здесь утверждается, — ИНЕРТНОСТЬ: ссылка, которую нельзя разрешить,
// даёт пустоту и ничего не ломает. Четыре её случая (§4 спеки) идут отдельными
// кейсами, потому что каждый ловится своей веткой резолвера.

afterEach(cleanup)

const answerBlock = (id: string, over: Partial<Block> = {}): Block => ({
  id,
  groupId: `g_${id}`,
  type: 'short_text',
  ...over,
})

describe('answerText — чем подставляется ответ', () => {
  it('текстовые типы отдают значение как есть', () => {
    expect(answerText(answerBlock('b'), 'Кирилл')).toBe('Кирилл')
    expect(answerText(answerBlock('b'), undefined)).toBe('')
    expect(answerText(answerBlock('b'), '')).toBe('')
  })

  it('выбор отдаёт подпись варианта, а не его id', () => {
    const block = answerBlock('b', {
      type: 'single_choice',
      settings: { options: [{ id: 'o1', label: 'Синий' }] },
    })
    expect(answerText(block, 'o1')).toBe('Синий')
    // Неизвестный id (ответ прежней версии) отдаётся как есть: факт ответа не теряется.
    expect(answerText(block, 'o9')).toBe('o9')
  })

  it('несколько вариантов — подписи через запятую', () => {
    const block = answerBlock('b', {
      type: 'multi_choice',
      settings: {
        options: [
          { id: 'o1', label: 'Чай' },
          { id: 'o2', label: 'Кофе' },
        ],
      },
    })
    expect(answerText(block, ['o1', 'o2'])).toBe('Чай, Кофе')
  })

  // Незаполненное согласие даёт ПУСТО, а не «Нет» (в отличие от таблицы ответов
  // кабинета): «Нет» посреди подписи вопроса было бы утверждением, которого респондент
  // не делал.
  it('согласие: отмеченное — «Да», неотмеченное — пусто', () => {
    const block = answerBlock('b', { type: 'consent' })
    expect(answerText(block, 'yes')).toBe('Да')
    expect(answerText(block, '')).toBe('')
  })
})

describe('mentionResolver — когда ссылка разрешима', () => {
  const src = answerBlock('src')
  const carrier: Block = {
    id: 'cap',
    groupId: 'g2',
    type: 'title',
    text: [{ t: 'Имя', ref: 'src' }],
  }
  const blocks = [src, carrier]

  it('источник выше носителя и отвечен — подставляется его ответ', () => {
    const resolve = mentionResolver(blocks, { src: 'Кирилл' })
    expect(resolve('src', 'cap')).toBe('Кирилл')
  })

  it('пустой ответ даёт пустоту', () => {
    expect(mentionResolver(blocks, {})('src', 'cap')).toBe('')
    expect(mentionResolver(blocks, { src: '' })('src', 'cap')).toBe('')
  })

  it('источника нет вовсе — пусто, а не поломка', () => {
    expect(mentionResolver(blocks, { src: 'Кирилл' })('нет-такого', 'cap')).toBe('')
  })

  it('источник не отвечаемый — пусто', () => {
    const heading: Block = { id: 'h', groupId: 'gh', type: 'heading', text: [{ t: 'Раздел' }] }
    const resolve = mentionResolver([heading, carrier], { h: 'что-то' })
    expect(resolve('h', 'cap')).toBe('')
  })

  // Обещание «ссылаемся только назад» держится и в рантайме, а не только списком в меню:
  // на многостраничной форме респондент возвращается назад, и ответ вопроса, стоящего
  // НИЖЕ, к этому моменту вполне существует.
  it('источник ниже носителя — пусто, даже если ответ есть', () => {
    const below = [carrier, src]
    expect(mentionResolver(below, { src: 'Кирилл' })('src', 'cap')).toBe('')
  })

  it('источник, скрытый условием, считается пустым', () => {
    const gate = answerBlock('gate')
    const hidden = answerBlock('hidden')
    // Правило показывает `hidden` только при «да»: блок стоит между источником и целью.
    const rule: Block = {
      id: 'L',
      groupId: 'gL',
      type: 'logic',
      logic: {
        when: { all: [{ blockId: 'gate', op: 'is', value: 'да' }] },
        then: [{ kind: 'show', target: 'hidden' }],
      },
    }
    const consumer: Block = {
      id: 'cap2',
      groupId: 'g3',
      type: 'title',
      text: [{ t: 'Имя', ref: 'hidden' }],
    }
    const docBlocks = [gate, rule, hidden, consumer]
    const answers = { gate: 'нет', hidden: 'Кирилл' }
    const plan = planForm(docBlocks, answers)
    expect(plan.visible.has('hidden')).toBe(false)
    expect(mentionResolver(docBlocks, answers, plan)('hidden', 'cap2')).toBe('')
    // Тот же документ без скрытия — подстановка работает: пустоту дало условие, а не
    // само наличие плана.
    const shown = planForm(docBlocks, { gate: 'да', hidden: 'Кирилл' })
    expect(
      mentionResolver(docBlocks, { gate: 'да', hidden: 'Кирилл' }, shown)('hidden', 'cap2'),
    ).toBe('Кирилл')
  })
})

describe('RichText — вывод подстановки', () => {
  const spans: Span[] = [{ t: 'Имя', ref: 'src' }, { t: ', укажите телефон' }]
  const withResolver = (resolve: ReturnType<typeof mentionResolver>, s: Span[] = spans) =>
    render(
      <MentionContext.Provider value={resolve}>
        <RichText spans={s} carrier="cap" />
      </MentionContext.Provider>,
    ).container

  const blocks = [
    answerBlock('src'),
    { id: 'cap', groupId: 'g2', type: 'title', text: spans } as Block,
  ]

  it('на месте куска стоит ответ респондента', () => {
    const c = withResolver(mentionResolver(blocks, { src: 'Кирилл' }))
    expect(c.textContent).toBe('Кирилл, укажите телефон')
  })

  it('без ответа кусок исчезает целиком', () => {
    const c = withResolver(mentionResolver(blocks, {}))
    expect(c.textContent).toBe(', укажите телефон')
  })

  // Провайдера нет — поверхность не про заполнение (полотно, диалог выбора типа):
  // печатается имя вопроса, то же самое, что уезжает в данные. Пустота была бы потерей
  // текста на ровном месте.
  it('без провайдера печатается имя вопроса', () => {
    const c = render(<RichText spans={spans} carrier="cap" />).container
    expect(c.textContent).toBe('Имя, укажите телефон')
  })

  it('марка остаётся на подставленном значении', () => {
    const c = withResolver(mentionResolver(blocks, { src: 'Кирилл' }), [
      { t: 'Имя', ref: 'src', m: ['b'] },
    ])
    const bold = c.querySelector('.rf-b')
    expect(bold?.textContent).toBe('Кирилл')
  })
})
