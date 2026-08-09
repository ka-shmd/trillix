import { designSchema, formSchemaSchema, MAX_FONT_SIZE, MIN_FONT_SIZE } from '@entities/formSchema'
import { designToVars, themeClass } from '@fields/design'
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
      font: { body: 'inter', heading: 'golos' },
      layout: { width: 'wide', fontSize: 18, density: 'roomy', align: 'center' },
      controls: { radius: 0, outline: 'border' },
      button: { variant: 'outline', width: 'full', align: 'center', size: 'lg' },
    },
    'кегль на нижней границе': { layout: { fontSize: MIN_FONT_SIZE } },
    'кегль на верхней границе': { layout: { fontSize: MAX_FONT_SIZE } },
    'радиус ноль — прямые углы': { controls: { radius: 0 } },
  }

  const bad: Record<string, unknown> = {
    'тема вне списка': { theme: 'auto' },
    'цвет без решётки': { palette: { text: '112233' } },
    'цвет в верхнем регистре': { palette: { accent: '#AABBCC' } },
    'цвет короткой формой': { palette: { canvas: '#abc' } },
    'цвет свободной нотацией': { palette: { field: 'rgb(0,0,0)' } },
    'шрифт вне списка': { font: { body: 'comic' } },
    'шрифт заголовка вне списка': { font: { heading: 'comic' } },
    'ширина вне списка': { layout: { width: 'huge' } },
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

  it('schemaVersion не поднимается — документ v4 с оформлением валиден', () => {
    const parsed = formSchemaSchema.safeParse({
      schemaVersion: 4,
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
        layout: { width: 'narrow', fontSize: 18, density: 'compact', align: 'center' },
        controls: { radius: 0 },
        font: { body: 'inter' },
      }),
    ).toEqual({
      '--rf-accent': '#00aa55',
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
})

describe('themeClass', () => {
  it.each([
    ['нет оформления', undefined, ''],
    ['светлая — дефолт, класса нет', { theme: 'light' } as const, ''],
    ['тема не задана', {} as const, ''],
    ['тёмная', { theme: 'dark' } as const, 'rf-theme-dark'],
  ])('%s', (_name, design, want) => {
    expect(themeClass(design)).toBe(want)
  })
})
