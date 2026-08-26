import { designSchema } from '@entities/formSchema'
import { describe, expect, it } from 'vitest'

import {
  coverFill,
  patch,
  patchCoverHeight,
  patchLogo,
  patchTop,
  PALETTE_FIELDS,
} from './designEdit'

describe('patch', () => {
  it('ставит значение в пустой документ', () => {
    expect(patch(undefined, 'palette', 'accent', '#00aa55')).toEqual({
      palette: { accent: '#00aa55' },
    })
  })

  it('не трогает соседние поля и другие группы', () => {
    const before = {
      theme: 'dark',
      palette: { accent: '#00aa55' },
      layout: { fontSize: 18 },
    } as const
    expect(patch(before, 'palette', 'text', '#111111')).toEqual({
      theme: 'dark',
      palette: { accent: '#00aa55', text: '#111111' },
      layout: { fontSize: 18 },
    })
  })

  it('снятие последнего значения убирает и группу', () => {
    // Иначе в схеме копятся пустые объекты, которых автор не создавал: документ
    // отличается от исходного при одинаковом виде.
    expect(
      patch({ palette: { accent: '#00aa55' } }, 'palette', 'accent', undefined),
    ).toBeUndefined()
  })

  it('снятие последнего значения оставляет остальной документ', () => {
    expect(
      patch({ theme: 'dark', palette: { accent: '#00aa55' } }, 'palette', 'accent', undefined),
    ).toEqual({ theme: 'dark' })
  })

  it('поставили и сняли — документ вернулся к исходному', () => {
    const started = { theme: 'dark' } as const
    const after = patch(patch(started, 'controls', 'radius', 0), 'controls', 'radius', undefined)
    expect(after).toEqual(started)
  })

  it('ноль сохраняется, а не читается как «снять»', () => {
    // Скругление 0 — осмысленный выбор автора (прямые углы).
    expect(patch(undefined, 'controls', 'radius', 0)).toEqual({ controls: { radius: 0 } })
  })

  it('результат остаётся валидным документом оформления', () => {
    let d = patch(undefined, 'layout', 'width', 900)
    d = patch(d, 'controls', 'outline', 'border')
    d = patch(d, 'button', 'size', 'lg')
    d = patch(d, 'palette', 'canvas', '#faf6f0')
    expect(designSchema.safeParse(d).success).toBe(true)
  })
})

describe('patchTop', () => {
  it('ставит поле верхнего уровня', () => {
    // font стал скаляром, когда шрифт свели к одному на форму: групповая правка дала
    // бы {font: {'': 'inter'}}, то есть документ, который контракт отвергнет.
    expect(patchTop(undefined, 'font', 'inter')).toEqual({ font: 'inter' })
  })

  it('снятие последнего поля схлопывает документ', () => {
    expect(patchTop({ font: 'inter' }, 'font', undefined)).toBeUndefined()
  })

  it('не трогает остальное', () => {
    expect(patchTop({ theme: 'dark', palette: { accent: '#00aa55' } }, 'font', 'golos')).toEqual({
      theme: 'dark',
      palette: { accent: '#00aa55' },
      font: 'golos',
    })
  })
})

describe('PALETTE_FIELDS', () => {
  it('перечисляет ровно поля палитры контракта', () => {
    // Забытое поле означает цвет, который контракт принимает, а панель не
    // показывает: настройка есть, добраться до неё нельзя.
    const inSchema = Object.keys(designSchema.shape.palette.unwrap().shape)
    expect(PALETTE_FIELDS.map((f) => f.key)).toEqual(inSchema)
  })
})

describe('patchTop — бейдж', () => {
  it('выключенный переключатель пишет false, включённый снимает ключ', () => {
    // «Показывать» выражается ОТСУТСТВИЕМ ключа: второе представление того же
    // состояния валидатор не примет (design.branding допускает только false).
    expect(patchTop(undefined, 'branding', false)).toEqual({ branding: false })
    expect(patchTop({ branding: false }, 'branding', undefined)).toBeUndefined()
    expect(patchTop({ theme: 'dark', branding: false }, 'branding', undefined)).toEqual({
      theme: 'dark',
    })
  })
})

// ХРОМ СТРАНИЦЫ — правка размеров логотипа и обложки. Отдельно от patch: объект
// хрома держит саму картинку и до undefined не схлопывается.
describe('patchLogo / patchCoverHeight', () => {
  it('ставит и меняет значение, не трогая картинку', () => {
    expect(patchLogo({ imageKey: 'ws/l.png' }, 'width', 140)).toEqual({
      imageKey: 'ws/l.png',
      width: 140,
    })
    expect(patchLogo({ imageKey: 'ws/l.png', radius: 50 }, 'radius', 0)).toEqual({
      imageKey: 'ws/l.png',
      radius: 0,
    })
  })

  it('снятое значение УДАЛЯЕТ ключ, а не пишет undefined', () => {
    const next = patchLogo({ imageKey: 'ws/l.png', width: 140 }, 'width', undefined)
    expect(next).toEqual({ imageKey: 'ws/l.png' })
    expect('width' in next).toBe(false)
  })

  it('высота обложки живёт при любом наполнении', () => {
    expect(patchCoverHeight({ color: '#ff8800' }, 40)).toEqual({ color: '#ff8800', height: 40 })
    const cleared = patchCoverHeight({ imageKey: 'ws/x.jpg', y: 20, height: 40 }, undefined)
    expect(cleared).toEqual({ imageKey: 'ws/x.jpg', y: 20 })
    expect('height' in cleared).toBe(false)
  })
})

describe('coverFill', () => {
  // Высота — свойство ПОЛОСЫ, а не того, чем она залита: смена наполнения её не
  // трогает. Сдвиг, наоборот, привязан к конкретной картинке и не переносится —
  // у цвета он схемой запрещён вовсе, а у новой картинки другая композиция.
  it('меняет наполнение, сохраняя высоту и теряя сдвиг', () => {
    expect(coverFill({ imageKey: 'ws/x.jpg', y: 20, height: 40 }, { color: '#ff8800' })).toEqual({
      color: '#ff8800',
      height: 40,
    })
    expect(coverFill({ color: '#ff8800', height: 40 }, { imageKey: 'ws/new.jpg' })).toEqual({
      imageKey: 'ws/new.jpg',
      height: 40,
    })
  })

  it('заводит обложку с нуля', () => {
    expect(coverFill(undefined, { color: '#ff8800' })).toEqual({ color: '#ff8800' })
  })
})
