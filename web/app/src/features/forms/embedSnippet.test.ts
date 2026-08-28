import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BLOCK_HEIGHT,
  DEFAULT_WIDGET_WIDTH,
  embedCode,
  frameUrl,
  iframeSnippet,
  openSnippet,
  previewCode,
  scriptSnippet,
  withoutMode,
  type SnippetOptions,
} from './embedSnippet'

const base: SnippetOptions = {
  baseUrl: 'https://f.trillix.ru',
  slug: 'opros',
  mode: 'block',
}

describe('withoutMode', () => {
  // `?mode=block` тянулся за человеком по разделам формы и оставался в адресе,
  // которым он делится: маршрут-получатель чужие ключи не вычищает, снимать их
  // надо на выходе.
  it('снимает вид вставки, остальное оставляет', () => {
    expect(withoutMode({ mode: 'block', w: 'team' })).toEqual({ w: 'team' })
  })

  it('адрес без вида не меняется', () => {
    expect(withoutMode({ w: 'team' })).toEqual({ w: 'team' })
    expect(withoutMode({})).toEqual({})
  })
})

describe('scriptSnippet', () => {
  it('блок — один тег со ссылкой на загрузчик того же домена, что и форма', () => {
    expect(scriptSnippet(base)).toBe(
      '<script src="https://f.trillix.ru/embed/v1.js" data-trillix-form="opros" async></script>',
    )
  })

  // Тег скрипта у всплывающей формы остался только под автооткрытие, и кнопки он
  // больше не рисует — отсюда явный `data-button="none"` (его отсутствие загрузчик
  // читает как «рисовать», ради вставок прошлых месяцев).
  it('всплывающая форма — своим атрибутом, без своей кнопки', () => {
    const code = scriptSnippet({ ...base, mode: 'widget', open: 'delay', openValue: 5 })
    expect(code).toContain('data-trillix-widget="opros"')
    expect(code).toContain('data-button="none"')
    expect(code).toContain('data-open="delay"')
    expect(code).toContain('data-open-value="5"')
    expect(code).not.toContain('data-trillix-form')
  })

  it('страница и прозрачный фон — режимом и флагом', () => {
    expect(scriptSnippet({ ...base, mode: 'page' })).toContain('data-mode="page"')
    expect(scriptSnippet({ ...base, transparent: true })).toContain('data-bg="transparent"')
  })

  it('тег скрипта остаётся одной строкой', () => {
    const code = scriptSnippet({ ...base, mode: 'widget', open: 'exit' })
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

describe('openSnippet', () => {
  it('вызов из кода — форма и вид, без предзаполнения', () => {
    const code = openSnippet(base)
    expect(code).toContain("form: 'opros'")
    expect(code).toContain("mode: 'block'")
    // Список полей уехал в вики: экран отдаёт вызов, а не инструкцию к нему.
    expect(code).not.toContain('prefill')
  })
})

describe('embedCode', () => {
  it('фрейм назван формой, а не словом «Форма»', () => {
    expect(embedCode({ ...base, title: 'Заявка на монтаж' })).toContain('title="Заявка на монтаж"')
    // Кавычка в названии иначе оборвала бы атрибут и превратила остаток в мусор.
    expect(embedCode({ ...base, title: 'Опрос "Лето"' })).toContain(
      'title="Опрос &quot;Лето&quot;"',
    )
    // Название без кабинета (тесты, будущие вызовы) — запасное слово.
    expect(embedCode(base)).toContain('title="Форма"')
  })

  // Старые атрибуты HTML4: их берут движки, которые до сих пор рисуют фрейму рамку
  // и внутренние поля, а `style` на таком сайте может быть отброшен политикой.
  it('у фрейма сняты рамка и внутренние поля старыми атрибутами', () => {
    expect(embedCode(base)).toContain('frameborder="0" marginheight="0" marginwidth="0"')
  })

  it('блок — фрейм с адресом в data-trillix-src плюс тег загрузчика', () => {
    const code = embedCode(base)
    expect(code).toContain('<iframe data-trillix-src="https://f.trillix.ru/r/opros?embed=block"')
    expect(code).toContain('<script async src="https://f.trillix.ru/embed/v1.js"></script>')
    // Пустой src обязателен: иначе браузер начнёт грузить форму раньше, чем
    // загрузчик подставит метки источника хост-страницы.
    expect(code).not.toContain(' src="https://f.trillix.ru/r/')
  })

  // Геометрия атрибутами, а не style: строгая CSP отбрасывает атрибут style, и блок
  // остался бы фреймом в 150 пикселей по умолчанию браузера.
  it('у блока размер атрибутами, у страницы — фиксированным слоем', () => {
    expect(embedCode(base)).toContain(`width="100%" height="${DEFAULT_BLOCK_HEIGHT}"`)
    expect(embedCode(base)).not.toContain('style=')
    expect(embedCode({ ...base, mode: 'page' })).toContain('position:fixed')
  })

  it('своя высота и выключенная подстройка едут во фрейм', () => {
    const code = embedCode({ ...base, height: 900, dynamicHeight: false })
    expect(code).toContain('height="900"')
    expect(code).toContain('data-dynamic-height="0"')
    // Умолчание не пишется: атрибут без него означает ровно то же самое.
    expect(embedCode(base)).not.toContain('data-dynamic-height')
  })

  it('настройки вида уезжают в адрес фрейма, а не в атрибуты', () => {
    const code = embedCode({ ...base, hideTitle: true, alignLeft: true, transparent: true })
    expect(code).toContain('hideTitle=1')
    expect(code).toContain('align=left')
    expect(code).toContain('bg=transparent')
    expect(code).not.toContain('data-hide-title')
  })

  // У всплывающей формы в потоке страницы ничего не стоит: готовый фрейм был бы
  // фреймом, который никогда не показывают.
  it('всплывающая форма по клику — загрузчик и кнопка сайта', () => {
    const code = embedCode({ ...base, mode: 'widget', position: 'center', width: 700 })
    expect(code).toContain('<script async src="https://f.trillix.ru/embed/v1.js"></script>')
    expect(code).toContain('data-trillix-open="opros"')
    expect(code).toContain('data-position="center"')
    expect(code).toContain('data-width="700"')
    expect(code).not.toContain('<iframe')
    // Своей кнопки у загрузчика больше нет — значит и тега скрипта с настройками
    // здесь быть не должно: открывает форму кнопка сайта.
    expect(code).not.toContain('data-trillix-widget')
  })

  it('всплывающая форма по триггеру — один тег скрипта без кнопки', () => {
    const code = embedCode({ ...base, mode: 'widget', open: 'scroll', openValue: 40 })
    expect(code).toContain('data-trillix-widget="opros"')
    expect(code).toContain('data-button="none"')
    expect(code).not.toContain('data-trillix-open')
  })

  it('предпросмотр отличается ровно флагом в адресе фрейма', () => {
    expect(embedCode({ ...base, preview: true })).toContain('preview=1')
    expect(embedCode(base)).not.toContain('preview=1')
  })
})

describe('previewCode', () => {
  it('у блока — тот же код плюс флаг предпросмотра', () => {
    expect(previewCode(base)).toBe(embedCode({ ...base, preview: true }))
  })

  // Кнопки на сцене быть не должно — автор пришёл смотреть на форму, — но открыть её
  // чем-то надо: невидимый элемент оставляет макету тот же путь, каким форма
  // откроется на настоящем сайте.
  it('у всплывающей формы кнопка невидима', () => {
    const code = previewCode({ ...base, mode: 'widget' })
    expect(code).toContain('data-trillix-open="opros"')
    expect(code).toContain('style="display:none"')
    expect(code).toContain('data-preview="1"')
  })

  // Предпросмотр отвечает на «как это выглядит», а не «когда появится»: ждать паузу
  // или прокручивать макет ради проверки вида — работа, которой автор не просил.
  it('триггер в макете всегда клик, каким бы он ни был настроен', () => {
    const code = previewCode({ ...base, mode: 'widget', open: 'delay', openValue: 5 })
    expect(code).toContain('data-trillix-open="opros"')
    expect(code).not.toContain('data-open="delay"')
  })
})
