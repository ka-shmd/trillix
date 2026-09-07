import {
  designSchema,
  formSchemaSchema,
  MAX_CUSTOM_CSS_LEN,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  SCHEMA_VERSION,
} from '@entities/formSchema'
import { designClasses, DESIGN_VAR_NAMES, designToVars, showFormBadge } from '@fields/design'
import { describe, expect, it } from 'vitest'

// Оформление формы (фаза 22, слайс 2). Таблица кейсов ТОГО ЖЕ СОСТАВА, что
// design_test.go на бэке: названия кейсов совпадают, поэтому расхождение видно
// диффом. Машинно сверяются состав переменных, списки значений и числа границ —
// это делает design_parity_test.go, читая отсюда и из fields/design.ts.

describe('designSchema — валидатор', () => {
  const ok: Record<string, unknown> = {
    'пустой объект — всё по умолчанию': {},
    'полный набор': {
      theme: 'dark',
      palette: {
        canvas: '#111111',
        field: '#1a1a1a',
        text: '#eeeeee',
        muted: '#999999',
        accent: '#00aa55',
        button: '#00aa55',
        buttonText: '#ffffff',
      },
      font: 'inter',
      layout: { width: 860, fontSize: 18, density: 'roomy', align: 'center' },
      controls: { radius: 0, outline: 'border' },
      button: {
        variant: 'outline',
        width: 'fixed',
        widthPx: 260,
        height: 52,
        align: 'center',
        weight: 'bold',
        fontSize: 18,
        radius: 8,
        marginTop: 16,
        paddingX: 28,
        size: 'lg',
      },
    },
    'кегль на нижней границе': { layout: { fontSize: MIN_FONT_SIZE } },
    'кегль на верхней границе': { layout: { fontSize: MAX_FONT_SIZE } },
    'радиус ноль — прямые углы': { controls: { radius: 0 } },
    'свой CSS': { css: '.rf-page { padding: 0 }' },
  }

  const bad: Record<string, unknown> = {
    'тема вне списка': { theme: 'auto' },
    'цвет без решётки': { palette: { text: '112233' } },
    'цвет в верхнем регистре': { palette: { accent: '#AABBCC' } },
    'цвет короткой формой': { palette: { canvas: '#abc' } },
    'цвет свободной нотацией': { palette: { field: 'rgb(0,0,0)' } },
    'шрифт вне списка': { font: 'comic' },
    // Бейджа в оформлении больше нет: намерение живёт живым свойством формы (ADR
    // §10). Ключ обязан отвергаться, иначе на один вопрос отвечали бы два места.
    'бейдж в оформлении': { branding: false },
    // `</` — второй рубеж после текстового узла React: единственная точка, где
    // авторский текст соседствует с HTML по существу.
    'CSS с закрывающим тегом': { css: '</style><script>alert(1)</script>' },
    'CSS сверх лимита': { css: 'a'.repeat(MAX_CUSTOM_CSS_LEN + 1) },
    'ширина ниже границы': { layout: { width: 399 } },
    'ширина выше границы': { layout: { width: 1201 } },
    'ширина дробная': { layout: { width: 700.5 } },
    'плотность вне списка': { layout: { density: 'tight' } },
    'выравнивание вне списка': { layout: { align: 'right' } },
    'кегль ниже границы': { layout: { fontSize: 13 } },
    'кегль выше границы': { layout: { fontSize: 21 } },
    'кегль дробный': { layout: { fontSize: 16.5 } },
    'радиус ниже границы': { controls: { radius: -1 } },
    'радиус выше границы': { controls: { radius: 25 } },
    'контур вне списка': { controls: { outline: 'dotted' } },
    'вид кнопки вне списка': { button: { variant: 'ghost' } },
    'ширина кнопки вне списка': { button: { width: 'half' } },
    'размер кнопки вне списка': { button: { size: 'xl' } },
    'лишний ключ': { themee: 'dark' },
    'лишний ключ во вложенном объекте': { layout: { widht: 'wide' } },
  }

  it.each(Object.entries(ok))('принимает: %s', (_name, value) => {
    expect(designSchema.safeParse(value).success).toBe(true)
  })

  it.each(Object.entries(bad))('отвергает: %s', (_name, value) => {
    expect(designSchema.safeParse(value).success).toBe(false)
  })
})

describe('designSchema в составе схемы формы', () => {
  it('оформление необязательно — документ без него валиден', () => {
    expect(formSchemaSchema.safeParse({ blocks: [] }).success).toBe(true)
  })

  it('мусор внутри design роняет разбор всей схемы', () => {
    expect(formSchemaSchema.safeParse({ blocks: [], design: { theme: 'auto' } }).success).toBe(false)
  })

  it('оформление версию формата не двигает — документ текущей версии валиден', () => {
    const parsed = formSchemaSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      blocks: [],
      design: { theme: 'dark' },
    })
    expect(parsed.success).toBe(true)
  })
})

describe('designToVars', () => {
  it('undefined и пустое оформление дают пустой объект', () => {
    // Контракт фазы: форма, у которой оформление не трогали, обязана выглядеть байт
    // в байт как до неё — надёжнее всего это держится тем, что мы не печатаем ни
    // одного объявления.
    expect(designToVars(undefined)).toEqual({})
    expect(designToVars({})).toEqual({})
  })

  it('тема сама по себе переменных не даёт', () => {
    // Тема выражается классом: color-scheme переменной не выразить.
    expect(designToVars({ theme: 'dark' })).toEqual({})
  })

  it('заданное переводится, незаданное молчит', () => {
    expect(
      designToVars({
        palette: { accent: '#00aa55' },
        layout: { width: 560, fontSize: 18, density: 'compact', align: 'center' },
        controls: { radius: 0 },
        font: 'inter',
      }),
    ).toEqual({
      '--rf-accent': '#00aa55',
      '--rf-accent-badge': '#00aa55',
      '--rf-column': '560px',
      '--rf-font-size': '18px',
      '--rf-density': '0.75',
      '--rf-align': 'center',
      '--rf-align-items': 'center',
      '--rf-radius': '0px',
      '--rf-font-family': 'Inter, system-ui, -apple-system, sans-serif',
    })
  })

  it('радиус 0 печатается, а не пропадает', () => {
    // Ловушка «нулевое значение неотличимо от незаданного»: прямые углы — выбор
    // автора, и он обязан доехать до CSS.
    expect(designToVars({ controls: { radius: 0 } })).toEqual({ '--rf-radius': '0px' })
  })

  // ПОТОЛОК ШИРИНЫ ПОЛЯ. Полная ширина — значение «100%», а не класс: переменная
  // подставляется прямо в max-width и в min(…, 100%). Флаг сильнее числа, и число при
  // нём НЕ стирается — оно ждёт возврата к фиксированной ширине.
  it('ширина поля: число, «100%» и приоритет флага', () => {
    expect(designToVars({ controls: { width: 480 } })).toEqual({ '--rf-input-max': '480px' })
    expect(designToVars({ controls: { fullWidth: true } })).toEqual({ '--rf-input-max': '100%' })
    expect(designToVars({ controls: { fullWidth: true, width: 480 } })).toEqual({
      '--rf-input-max': '100%',
    })
    expect(designToVars({ controls: {} })).toEqual({})
  })

  it('высота поля — числом в px', () => {
    expect(designToVars({ controls: { height: 44 } })).toEqual({ '--rf-control-h': '44px' })
  })

  // НОЛЬ У ТОЛЩИНЫ КРАЯ — ЗАКОННОЕ ЗНАЧЕНИЕ (края нет), а не «не задано». Проверка на
  // истинность вместо сравнения с undefined съела бы ровно этот случай.
  it('воздух вокруг поля: ноль печатается, отсутствие — нет', () => {
    expect(designToVars({ controls: { paddingX: 0 } })).toEqual({ '--rf-input-px': '0px' })
    expect(designToVars({ controls: { marginBottom: 0 } })).toEqual({ '--rf-space-q': '0px' })
    expect(designToVars({ controls: { paddingX: 12, marginBottom: 32 } })).toEqual({
      '--rf-input-px': '12px',
      '--rf-space-q': '32px',
    })
  })

  it('толщина края: ноль печатается, отсутствие — нет', () => {
    expect(designToVars({ controls: { borderWidth: 0 } })).toEqual({ '--rf-ring-w': '0px' })
    expect(designToVars({ controls: { borderWidth: 3 } })).toEqual({ '--rf-ring-w': '3px' })
    expect(designToVars({ controls: {} })).toEqual({})
  })
})

describe('designClasses', () => {
  it.each([
    ['нет оформления', undefined, ''],
    ['светлая — дефолт, класса нет', { theme: 'light' } as const, ''],
    ['тема не задана', {} as const, ''],
    ['тёмная', { theme: 'dark' } as const, 'rf-theme-dark'],
    ['контур рамкой', { controls: { outline: 'border' } } as const, 'rf-outline-border'],
    ['без контура', { controls: { outline: 'none' } } as const, 'rf-outline-none'],
    ['тень — дефолт, класса нет', { controls: { outline: 'shadow' } } as const, ''],
    ['снятая тень', { controls: { shadow: false } } as const, 'rf-shadow-off'],
    ['контурная кнопка', { button: { variant: 'outline' } } as const, 'rf-btn-outline'],
    ['заливка — дефолт, класса нет', { button: { variant: 'solid' } } as const, ''],
    [
      'всё сразу — порядок стабилен',
      {
        theme: 'dark',
        controls: { outline: 'border', shadow: false },
        button: { variant: 'outline' },
      } as const,
      'rf-theme-dark rf-outline-border rf-shadow-off rf-btn-outline',
    ],
  ])('%s', (_name, design, want) => {
    expect(designClasses(design)).toBe(want)
  })
})

describe('designToVars — кнопка', () => {
  // ТРИ РЕЖИМА ШИРИНЫ. Число читается только в fixed: в остальных оно лежит в
  // документе и ждёт возврата, поэтому его присутствие ничего не печатает.
  // ЧИСЛО СИЛЬНЕЕ ГОТОВОГО РАЗМЕРА, И ТОЛЬКО ПО ВЫСОТЕ: поля и кегль остаются от
  // набора, иначе одна правка высоты молча пересобирала бы кнопку целиком.
  // ТРИ ПОЛОЖЕНИЯ. `left` — дефолт fields.css, поэтому не печатается вовсе.
  it('положение: слева молчит, по центру и справа — свои значения justify', () => {
    expect(designToVars({ button: { align: 'left' } })['--rf-submit-justify']).toBeUndefined()
    expect(designToVars({ button: { align: 'center' } })['--rf-submit-justify']).toBe('center')
    expect(designToVars({ button: { align: 'right' } })['--rf-submit-justify']).toBe('flex-end')
  })

  // ВОЗДУХ КНОПКИ. Верхний — свой и добавочный, поэтому ноль печатается: это
  // выбор «без добавки», а не «не задано». Боковые поля сильнее готового размера.
  it('воздух кнопки: свой верхний и боковые поля поверх размера', () => {
    expect(designToVars({ button: { marginTop: 0 } })).toEqual({ '--rf-submit-mt': '0px' })
    expect(designToVars({ button: { marginTop: 16 } })).toEqual({ '--rf-submit-mt': '16px' })
    expect(designToVars({ button: { size: 'lg', paddingX: 28 } })).toEqual({
      '--rf-submit-h': '2.75rem',
      '--rf-submit-px': '28px',
      '--rf-submit-ratio': '1',
    })
  })

  it('кегль и скругление кнопки — своими токенами поверх общих', () => {
    expect(designToVars({ button: { fontSize: 18, radius: 8 } })).toEqual({
      '--rf-submit-size': '18px',
      '--rf-submit-radius': '8px',
    })
  })

  it('высота: число перебивает размер, не трогая поля и кегль', () => {
    expect(designToVars({ button: { size: 'lg' } })).toEqual({
      '--rf-submit-h': '2.75rem',
      '--rf-submit-px': '2rem',
      '--rf-submit-ratio': '1',
    })
    expect(designToVars({ button: { size: 'lg', height: 52 } })).toEqual({
      '--rf-submit-h': '52px',
      '--rf-submit-px': '2rem',
      '--rf-submit-ratio': '1',
    })
    expect(designToVars({ button: { height: 52 } })).toEqual({ '--rf-submit-h': '52px' })
  })

  it('ширина: по тексту, во всю и фиксированная', () => {
    expect(designToVars({ button: { width: 'auto' } })['--rf-submit-width']).toBeUndefined()
    expect(designToVars({ button: { width: 'full' } })['--rf-submit-width']).toBe('100%')
    expect(designToVars({ button: { width: 'fixed', widthPx: 260 } })['--rf-submit-width']).toBe(
      '260px',
    )
    // Режим есть, числа нет — печатается дефолт, а не пустота: иначе кнопка молча
    // осталась бы «по тексту», хотя автор выбрал фиксированную.
    expect(designToVars({ button: { width: 'fixed' } })['--rf-submit-width']).toBe('200px')
    expect(designToVars({ button: { width: 'auto', widthPx: 260 } })['--rf-submit-width']).toBe(
      undefined,
    )
  })

  it('положение — justify ряда, а не align-self кнопки', () => {
    // Кнопка лежит в .rf-nav — это flex-СТРОКА, и align-self двигал бы её по
    // вертикали, где двигать нечего. Первая редакция слайса ошиблась именно осью:
    // значение в стиле стояло, а кнопка не двигалась ни на одной поверхности.
    expect(designToVars({ button: { align: 'center' } })).toEqual({
      '--rf-submit-justify': 'center',
    })
  })

  it('во всю ширину плюс центр — обе переменные, центр инертен', () => {
    // Растянутой кнопке двигаться некуда, но отдельной ветки для этого нет
    // намеренно: инертное правило равно отсутствующему.
    expect(designToVars({ button: { width: 'full', align: 'center' } })).toEqual({
      '--rf-submit-justify': 'center',
      '--rf-submit-width': '100%',
    })
  })

  it('толщина: дефолтная ступень молчит, остальные печатают число', () => {
    // `semibold` — дефолт fields.css (--rf-submit-weight: 600), и печатать его значило
    // бы писать в документ то, что и так есть.
    expect(designToVars({ button: { weight: 'semibold' } })).toEqual({})
    expect(designToVars({ button: { weight: 'normal' } })).toEqual({
      '--rf-submit-weight': '400',
    })
    expect(designToVars({ button: { weight: 'bold' } })).toEqual({
      '--rf-submit-weight': '700',
    })
  })

  it('средний размер переменных не печатает', () => {
    // md — дефолт fields.css; печатать для него переменные значило бы писать в
    // документ то, что и так есть.
    expect(designToVars({ button: { size: 'md' } })).toEqual({})
  })

  it('крупный размер даёт три метрики', () => {
    expect(designToVars({ button: { size: 'lg' } })).toEqual({
      '--rf-submit-h': '2.75rem',
      '--rf-submit-px': '2rem',
      '--rf-submit-ratio': '1',
    })
  })
})

describe('DESIGN_VAR_NAMES', () => {
  it('перечисляет ровно то, что может напечатать designToVars', () => {
    // Список нужен рендереру, чтобы СНЯТЬ с корня документа оформление, напечатанное
    // сервером из другого снапшота (оболочка и схема кешируются раздельно). Забытая в
    // нём переменная — это цвет, который останется от прошлой версии формы.
    const everything = designToVars({
      theme: 'dark',
      palette: {
        canvas: '#101014',
        field: '#1a1a20',
        text: '#f0f0f0',
        muted: '#9a9a9a',
        placeholder: '#8a8a8a',
        border: '#d0d0d0',
        accent: '#12ab34',
        button: '#12ab34',
        buttonText: '#ffffff',
      },
      font: 'inter',
      layout: { width: 800, fontSize: 18, density: 'roomy', align: 'center' },
      // width, а не fullWidth: флаг сильнее числа и печатает ту же переменную, а
      // здесь нужен документ, из которого выходит КАЖДАЯ переменная.
      controls: {
        width: 480,
        height: 44,
        borderWidth: 2,
        paddingX: 12,
        marginBottom: 32,
        radius: 12,
        outline: 'border',
      },
      button: {
        variant: 'outline',
        width: 'fixed',
        widthPx: 260,
        height: 52,
        align: 'center',
        // Ступень, отличная от дефолта: `semibold` переменной не печатает, и с ним
        // документ не дал бы КАЖДУЮ переменную, ради чего кейс и собран.
        weight: 'bold',
        fontSize: 18,
        radius: 8,
        marginTop: 16,
        paddingX: 28,
        size: 'lg',
      },
    })
    expect(Object.keys(everything).sort()).toEqual([...DESIGN_VAR_NAMES].sort())
  })
})

describe('showFormBadge', () => {
  it('бейдж есть всегда, кроме «просил снять И тариф даёт»', () => {
    // Правило одно на две стороны: сервер печатает его респонденту, кабинет считает
    // тем же выражением для превью. Разойдись они — превью показывало бы автору не ту
    // форму, которую увидят люди (ровно этот дефект и нашёлся в слайсе 6).
    //
    // Намерение приезжает флагом формы, а не оформлением: бейдж не в документе (ADR
    // §10), и снимается он без перепубликации.
    expect(showFormBadge(true, true)).toBe(true)
    expect(showFormBadge(true, false)).toBe(true)
    expect(showFormBadge(false, false)).toBe(true)
    expect(showFormBadge(false, true)).toBe(false)
  })
})
