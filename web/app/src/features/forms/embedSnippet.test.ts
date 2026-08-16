import { describe, expect, it } from 'vitest'

import { textFromString, type Block } from '@entities/formSchema'
import {
  DEFAULT_BLOCK_HEIGHT,
  DEFAULT_WIDGET_WIDTH,
  frameUrl,
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

describe('scriptSnippet: настройки вида и предпросмотр', () => {
  it('скрытый заголовок и выравнивание — отдельными атрибутами', () => {
    const code = scriptSnippet({ ...base, hideTitle: true, alignLeft: true })
    expect(code).toContain('data-hide-title="1"')
    expect(code).toContain('data-align="left"')
  })

  // У страницы форма и есть вся страница: спрятать её заголовок значит оставить
  // документ вовсе без него, поэтому атрибут туда не пишется.
  it('скрытый заголовок — не у страницы', () => {
    expect(scriptSnippet({ ...base, mode: 'page', hideTitle: true })).not.toContain(
      'data-hide-title',
    )
    expect(frameUrl({ ...base, mode: 'page', hideTitle: true })).not.toContain('hideTitle')
    expect(scriptSnippet({ ...base, mode: 'widget', hideTitle: true })).toContain('data-hide-title')
  })

  // Прижатие влево есть только у блока: у виджета и страницы поля холста отделяют
  // форму от края панели и края экрана. Настройка, включённая у блока, не должна
  // уезжать в сниппет при переключении вида — поэтому проверка в генераторе, а не
  // только в панели.
  it('выравнивание влево — только у блока', () => {
    expect(scriptSnippet({ ...base, mode: 'widget', alignLeft: true })).not.toContain('data-align')
    expect(scriptSnippet({ ...base, mode: 'page', alignLeft: true })).not.toContain('data-align')
    expect(frameUrl({ ...base, mode: 'page', alignLeft: true })).not.toContain('align=left')
    expect(frameUrl({ ...base, alignLeft: true })).toContain('align=left')
  })

  // Умолчание в сниппет не пишется: атрибут без него значит ровно то же самое, а
  // лишняя строка в коде на чужой странице — это вопрос «а это зачем?».
  it('высота блока пишется, только когда автор её менял', () => {
    expect(scriptSnippet({ ...base, height: DEFAULT_BLOCK_HEIGHT })).not.toContain('data-height')
    expect(scriptSnippet({ ...base, height: 400 })).toContain('data-height="400"')
    // У виджета и страницы своей высоты нет: её ведут модалка и вьюпорт.
    expect(scriptSnippet({ ...base, mode: 'page', height: 400 })).not.toContain('data-height')
  })

  // ЭТО ЕДИНСТВЕННОЕ ОТЛИЧИЕ кода, который исполняется в макете, от кода, который
  // автор копирует. Флаг обязан появляться только по явной просьбе — иначе вставка
  // на настоящем сайте молча перестала бы принимать ответы.
  it('флаг предпросмотра — только когда его попросили', () => {
    expect(scriptSnippet(base)).not.toContain('data-preview')
    expect(scriptSnippet({ ...base, preview: true })).toContain('data-preview="1"')
    expect(iframeSnippet(base)).not.toContain('preview=1')
    expect(iframeSnippet({ ...base, preview: true })).toContain('preview=1')
  })
})

describe('scriptSnippet: настройки виджета', () => {
  const widget: SnippetOptions = { ...base, mode: 'widget' }

  // Панель ВСЕГДА присылает значения — умолчания в том числе, — поэтому проверяется
  // именно «прислали дефолт», а не «не прислали ничего»: сниппет на чужой странице не
  // должен нести строку, которая ничего не меняет.
  it('угол, ширина и подложка пишутся только при отходе от умолчания', () => {
    const plain = scriptSnippet({
      ...widget,
      position: 'bottom-right',
      width: DEFAULT_WIDGET_WIDTH,
      overlay: true,
    })
    expect(plain).not.toContain('data-position')
    expect(plain).not.toContain('data-width')
    expect(plain).not.toContain('data-overlay')
    const tuned = scriptSnippet({
      ...widget,
      position: 'top-left',
      width: 420,
      overlay: false,
    })
    expect(tuned).toContain('data-position="top-left"')
    expect(tuned).toContain('data-width="420"')
    expect(tuned).toContain('data-overlay="none"')
  })

  // Триггер и его число едут парой: «через паузу» без числа означало бы «через
  // сколько-то», а умолчание живёт в загрузчике и здесь не дублируется.
  it('автооткрытие — триггером и значением, клик не пишется вовсе', () => {
    expect(scriptSnippet({ ...widget, open: 'click', openValue: 5 })).not.toContain('data-open')
    const delayed = scriptSnippet({ ...widget, open: 'delay', openValue: 8 })
    expect(delayed).toContain('data-open="delay"')
    expect(delayed).toContain('data-open-value="8"')
    expect(scriptSnippet({ ...widget, open: 'exit' })).toContain('data-open="exit"')
  })

  it('эмодзи экранируется, движение — отдельным атрибутом', () => {
    const code = scriptSnippet({ ...widget, emoji: '👋', emojiAnimation: 'bounce' })
    expect(code).toContain('data-emoji="👋"')
    expect(code).toContain('data-emoji-animation="bounce"')
    // Эмодзи вводит автор, и оно уезжает в атрибут на чужой странице — кавычка в нём
    // оборвала бы сниппет так же, как в надписи кнопки.
    expect(scriptSnippet({ ...widget, emoji: '" onload="x' })).toContain(
      'data-emoji="&quot; onload=&quot;x"',
    )
    // «Без движения» — умолчание загрузчика, писать его в сниппет незачем; движение без
    // эмодзи не значит ничего, и атрибута тоже быть не должно.
    expect(scriptSnippet({ ...widget, emoji: '👋', emojiAnimation: 'none' })).not.toContain(
      'data-emoji-animation',
    )
    expect(scriptSnippet({ ...widget, emojiAnimation: 'wave' })).not.toContain('data-emoji')
  })

  it('уборка после отправки — флагом', () => {
    expect(scriptSnippet({ ...widget, hideOnSubmit: true })).toContain('data-hide-on-submit="1"')
    expect(scriptSnippet(widget)).not.toContain('data-hide-on-submit')
  })

  // Живая высота — свойство блока в потоке: у виджета её ведёт модалка, у страницы
  // вьюпорт, и атрибут там значил бы «настройка есть, но ни на что не влияет».
  it('живая высота выключается только у блока', () => {
    expect(scriptSnippet({ ...base, dynamicHeight: false })).toContain('data-dynamic-height="0"')
    expect(scriptSnippet({ ...base, dynamicHeight: true })).not.toContain('data-dynamic-height')
    expect(scriptSnippet({ ...widget, dynamicHeight: false })).not.toContain('data-dynamic-height')
    expect(scriptSnippet({ ...base, mode: 'page', dynamicHeight: false })).not.toContain(
      'data-dynamic-height',
    )
  })
})

describe('frameUrl', () => {
  it('тот же адрес, что у ссылки на форму, плюс настройки вида', () => {
    expect(frameUrl(base)).toBe('https://f.trillix.ru/r/opros?embed=block')
    const tuned = frameUrl({ ...base, transparent: true, hideTitle: true, alignLeft: true })
    expect(tuned).toContain('bg=transparent')
    expect(tuned).toContain('hideTitle=1')
    expect(tuned).toContain('align=left')
  })

  it('у виджета своего адреса нет — та же форма блоком', () => {
    expect(frameUrl({ ...base, mode: 'widget' })).toContain('embed=block')
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

  // «Страница» замещает содержимое чужой страницы, а не встаёт в поток высоким
  // блоком: без фиксированного слоя этот режим отличался бы от блока только высотой.
  it('страница — фиксированный слой во весь вьюпорт, без ширины и высоты в атрибутах', () => {
    const code = iframeSnippet({ ...base, mode: 'page', height: 500 })
    expect(code).toContain('position:fixed')
    expect(code).toContain('inset:0')
    expect(code).not.toContain('height="500"')
    expect(iframeSnippet(base)).not.toContain('position:fixed')
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

  // Ответ multi_choice — массив id вариантов, а предзаполнение передаёт строку:
  // предложи мы его здесь, посетитель увидел бы группу без единой галочки и получил
  // бы «ожидался список вариантов» на поле, которого не касался.
  it('вопрос с несколькими вариантами не предлагается', () => {
    const multi = [
      block({ id: 'blk_t', groupId: 'gm', type: 'label', text: textFromString('Языки') }),
      block({ id: 'blk_m', groupId: 'gm', type: 'multi_choice' }),
      block({ id: 'blk_s', groupId: 'gs', type: 'single_choice' }),
    ]
    expect(prefillFields(multi).map((f) => f.blockId)).toEqual(['blk_s'])
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
