import { describe, expect, it } from 'vitest'

import { textFromString, type Block } from '@entities/formSchema'
import {
  iframeSnippet,
  prefillFields,
  prefillSnippet,
  scriptSnippet,
  type SnippetOptions,
} from './embedSnippet'

const base: SnippetOptions = {
  baseUrl: 'https://f.trillix.ru',
  slug: 'opros',
  mode: 'block',
}

const block = (over: Partial<Block>): Block =>
  ({
    id: 'blk_1',
    groupId: 'g1',
    type: 'short_text',
    ...over,
  }) as Block

describe('scriptSnippet', () => {
  it('блок — один тег со ссылкой на загрузчик того же домена, что и форма', () => {
    expect(scriptSnippet(base)).toBe(
      '<script src="https://f.trillix.ru/embed/v1.js" data-trillix-form="opros" async></script>',
    )
  })

  it('виджет — своим атрибутом, с надписью и углом', () => {
    const code = scriptSnippet({
      ...base,
      mode: 'widget',
      label: 'Оставить заявку',
      position: 'bottom-left',
    })
    expect(code).toContain('data-trillix-widget="opros"')
    expect(code).toContain('data-label="Оставить заявку"')
    expect(code).toContain('data-position="bottom-left"')
    expect(code).not.toContain('data-trillix-form')
  })

  it('страница и прозрачный фон — режимом и флагом', () => {
    expect(scriptSnippet({ ...base, mode: 'page' })).toContain('data-mode="page"')
    expect(scriptSnippet({ ...base, transparent: true })).toContain('data-bg="transparent"')
  })

  // Надпись вводит владелец формы, а уезжает она в HTML-атрибут на ЧУЖОЙ странице:
  // кавычка оборвала бы атрибут и превратила остаток сниппета в мусор там, куда мы
  // уже не попадём.
  it('надпись с кавычками не рвёт разметку', () => {
    const code = scriptSnippet({ ...base, mode: 'widget', label: 'Оставить "заявку" <b>' })
    expect(code).toContain('data-label="Оставить &quot;заявку&quot; &lt;b&gt;"')
    expect(code).toMatch(/^<script src="[^"]+" [^>]*async><\/script>$/)
  })
})

describe('iframeSnippet', () => {
  // DoD фазы: сниппет и ссылка ведут на один и тот же публичный адрес.
  it('ведёт на тот же публичный адрес, что и ссылка на форму', () => {
    expect(iframeSnippet(base)).toContain('src="https://f.trillix.ru/r/opros?embed=block"')
  })

  it('виджета без скрипта не бывает — отдаём блок', () => {
    expect(iframeSnippet({ ...base, mode: 'widget' })).toContain('embed=block')
  })

  it('высота задаётся сразу: подстраиваться простому iframe нечем', () => {
    expect(iframeSnippet({ ...base, height: 500 })).toContain('height="500"')
  })
})

describe('prefillFields', () => {
  const blocks: Block[] = [
    block({ id: 'blk_t1', groupId: 'g1', type: 'label', text: textFromString('Ваша почта') }),
    block({ id: 'blk_f1', groupId: 'g1', type: 'email' }),
    block({ id: 'blk_t2', groupId: 'g2', type: 'label', text: textFromString('Комментарий') }),
    block({ id: 'blk_f2', groupId: 'g2', type: 'long_text' }),
    block({ id: 'blk_img', groupId: 'g3', type: 'image' }),
  ]

  it('только отвечаемые блоки, с подписью своего вопроса', () => {
    expect(prefillFields(blocks)).toEqual([
      { blockId: 'blk_f1', caption: 'Ваша почта' },
      { blockId: 'blk_f2', caption: 'Комментарий' },
    ])
  })

  it('вопрос без заголовка всё равно предзаполняем', () => {
    const naked = [block({ id: 'blk_x', groupId: 'g9', type: 'short_text' })]
    expect(prefillFields(naked)).toEqual([{ blockId: 'blk_x', caption: 'Без заголовка' }])
  })
})

describe('prefillSnippet', () => {
  it('отдаёт объект целиком, с подписями в комментариях', () => {
    const code = prefillSnippet(base, [{ blockId: 'blk_f1', caption: 'Ваша почта' }])
    expect(code).toContain("form: 'opros'")
    expect(code).toContain("'blk_f1': '', // Ваша почта")
  })

  it('форма без вопросов — вызов без предзаполнения', () => {
    expect(prefillSnippet(base, [])).not.toContain('prefill')
  })
})
