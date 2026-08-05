import { describe, expect, it } from 'vitest'

import {
  DEFAULT_HEIGHT,
  DEFAULT_LABEL,
  frameSrc,
  isHttpUrl,
  optionsFromAttrs,
  readFrameMessage,
  scriptOrigin,
  type MountOptions,
} from './api'

const attrs = (map: Record<string, string>) => ({
  getAttribute: (name: string) => map[name] ?? null,
})

describe('scriptOrigin', () => {
  // Захардкоженный домен увёл бы вставку на prod-local в прод и наоборот.
  it('берёт origin из адреса загрузчика', () => {
    expect(scriptOrigin('https://f.trillix.ru/embed/v1.js')).toBe('https://f.trillix.ru')
    expect(scriptOrigin('https://f.localhost/embed/v1.js?v=2')).toBe('https://f.localhost')
  })

  it('нечитаемый адрес — пустая строка, вставки не будет', () => {
    expect(scriptOrigin('')).toBe('')
    expect(scriptOrigin('embed/v1.js')).toBe('')
  })
})

describe('frameSrc', () => {
  const base: MountOptions = { form: 'opros', mode: 'block' }

  it('ведёт на публичный адрес формы с режимом', () => {
    expect(frameSrc('https://f.trillix.ru', base, '')).toBe(
      'https://f.trillix.ru/r/opros?embed=block',
    )
  })

  it('прозрачный фон — параметром', () => {
    expect(frameSrc('https://f.trillix.ru', { ...base, transparent: true }, '')).toContain(
      'bg=transparent',
    )
  })

  // Внутри фрейма location.search — уже наш адрес: без проброса метки чужого
  // лендинга не доехали бы до аналитики никогда.
  it('пробрасывает метки источника с хост-страницы', () => {
    const src = frameSrc('https://f.trillix.ru', base, '?utm_source=vk&utm_campaign=may')
    expect(src).toContain('utm_source=vk')
    expect(src).toContain('utm_campaign=may')
  })

  it('чужие параметры хост-страницы в аналитику не уезжают', () => {
    const src = frameSrc('https://f.trillix.ru', base, '?sessionToken=secret&utm_source=vk')
    expect(src).not.toContain('sessionToken')
    expect(src).toContain('utm_source=vk')
  })

  it('slug экранируется', () => {
    expect(frameSrc('https://f.trillix.ru', { ...base, form: 'a b/c' }, '')).toContain(
      '/r/a%20b%2Fc?',
    )
  })
})

describe('optionsFromAttrs', () => {
  it('читает сниппет блока', () => {
    expect(optionsFromAttrs(attrs({ 'data-trillix-form': 'opros' }))).toEqual({
      form: 'opros',
      mode: 'block',
      transparent: false,
      height: DEFAULT_HEIGHT,
      redirect: 'top',
      label: DEFAULT_LABEL,
      position: 'bottom-right',
    })
  })

  // Виджет узнаётся по своему атрибуту: он единственный ничего не вставляет в поток,
  // и путать его с блоком опечаткой в data-mode («форма пропала со страницы») незачем.
  it('виджет — по своему атрибуту, с надписью и углом', () => {
    const opts = optionsFromAttrs(
      attrs({
        'data-trillix-widget': 'opros',
        'data-label': 'Оставить заявку',
        'data-position': 'bottom-left',
      }),
    )
    expect(opts?.mode).toBe('widget')
    expect(opts?.form).toBe('opros')
    expect(opts?.label).toBe('Оставить заявку')
    expect(opts?.position).toBe('bottom-left')
  })

  it('страница — режимом у обычного сниппета', () => {
    expect(optionsFromAttrs(attrs({ 'data-trillix-form': 'a', 'data-mode': 'page' }))?.mode).toBe(
      'page',
    )
    // Неизвестный режим — блок: сниппет с опечаткой обязан показать форму, а не пропасть.
    expect(optionsFromAttrs(attrs({ 'data-trillix-form': 'a', 'data-mode': 'popup' }))?.mode).toBe(
      'block',
    )
  })

  it('пустая надпись — дефолтная, а не пустая кнопка', () => {
    expect(optionsFromAttrs(attrs({ 'data-trillix-widget': 'a', 'data-label': '' }))?.label).toBe(
      DEFAULT_LABEL,
    )
  })

  it('чужой тег без нашего атрибута — не наш узел', () => {
    expect(optionsFromAttrs(attrs({}))).toBeNull()
    expect(optionsFromAttrs(attrs({ 'data-trillix-form': '' }))).toBeNull()
  })

  it('переход внутри фрейма — только по явной просьбе', () => {
    expect(
      optionsFromAttrs(attrs({ 'data-trillix-form': 'a', 'data-redirect': 'frame' }))?.redirect,
    ).toBe('frame')
    expect(
      optionsFromAttrs(attrs({ 'data-trillix-form': 'a', 'data-redirect': 'top' }))?.redirect,
    ).toBe('top')
  })

  // Мусор в атрибуте не должен схлопывать блок в ноль на чужой странице.
  it('негодная высота — дефолт', () => {
    const bad = ['', '0', '-100', '500px', 'много']
    for (const height of bad) {
      expect(
        optionsFromAttrs(attrs({ 'data-trillix-form': 'a', 'data-height': height }))?.height,
      ).toBe(DEFAULT_HEIGHT)
    }
    expect(
      optionsFromAttrs(attrs({ 'data-trillix-form': 'a', 'data-height': '300' }))?.height,
    ).toBe(300)
  })
})

describe('readFrameMessage', () => {
  const ok = (type: string, rest: Record<string, unknown> = {}) => ({
    source: 'trillix',
    v: 1,
    type,
    ...rest,
  })

  it('разбирает сообщения фрейма', () => {
    expect(readFrameMessage(ok('ready'))).toEqual({ type: 'ready' })
    expect(readFrameMessage(ok('resize', { height: 640 }))).toEqual({ type: 'resize', height: 640 })
    expect(readFrameMessage(ok('page', { index: 2 }))).toEqual({ type: 'page', index: 2 })
    expect(readFrameMessage(ok('submit', { submissionId: 'x' }))).toEqual({
      type: 'submit',
      submissionId: 'x',
    })
    expect(readFrameMessage(ok('redirect', { url: 'https://example.org' }))).toEqual({
      type: 'redirect',
      url: 'https://example.org',
    })
  })

  // На чужой странице в message прилетает чужой трафик: чаты, аналитика, расширения.
  it('чужие сообщения отбрасываются', () => {
    expect(readFrameMessage(null)).toBeNull()
    expect(readFrameMessage('resize')).toBeNull()
    expect(readFrameMessage({ type: 'resize', height: 100 })).toBeNull()
    expect(readFrameMessage({ source: 'other', v: 1, type: 'resize', height: 100 })).toBeNull()
    expect(readFrameMessage({ source: 'trillix', v: 2, type: 'resize', height: 100 })).toBeNull()
    expect(readFrameMessage(ok('unknown'))).toBeNull()
  })

  it('битая полезная нагрузка отбрасывается', () => {
    expect(readFrameMessage(ok('resize'))).toBeNull()
    expect(readFrameMessage(ok('resize', { height: '640' }))).toBeNull()
    expect(readFrameMessage(ok('resize', { height: 0 }))).toBeNull()
    expect(readFrameMessage(ok('page', { index: 'first' }))).toBeNull()
    expect(readFrameMessage(ok('submit', { submissionId: 42 }))).toBeNull()
  })

  // Ссылка уходит в location ЧУЖОЙ страницы: javascript: сюда доехать не должен.
  it('переход только по http(s)', () => {
    expect(readFrameMessage(ok('redirect', { url: 'javascript:alert(1)' }))).toBeNull()
    expect(readFrameMessage(ok('redirect', { url: 'data:text/html,x' }))).toBeNull()
    expect(readFrameMessage(ok('redirect', { url: '/relative' }))).toBeNull()
    expect(readFrameMessage(ok('redirect', { url: 'http://example.org' }))).not.toBeNull()
  })
})

describe('isHttpUrl', () => {
  it('пропускает только абсолютные http(s)', () => {
    expect(isHttpUrl('https://example.org/a?b=1')).toBe(true)
    expect(isHttpUrl('http://example.org')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('mailto:a@b.c')).toBe(false)
    expect(isHttpUrl(42)).toBe(false)
    expect(isHttpUrl(null)).toBe(false)
  })
})

describe('frameSrc: предзаполнение', () => {
  const base: MountOptions = { form: 'opros', mode: 'block' }

  it('уезжает параметрами pf.<id блока>', () => {
    const src = frameSrc(
      'https://f.trillix.ru',
      { ...base, prefill: { blk_1: 'ivan@site.ru' } },
      '',
    )
    expect(src).toContain('pf.blk_1=ivan%40site.ru')
  })

  it('пустое значение не подставляется', () => {
    const src = frameSrc('https://f.trillix.ru', { ...base, prefill: { blk_1: '' } }, '')
    expect(src).not.toContain('pf.blk_1')
  })
})

// Переход после отправки внутри фрейма может исполнить ТОЛЬКО фрейм: хост, получив
// сообщение redirect, вправе лишь промолчать. Пока выбор владельца сайта оставался
// знанием одного загрузчика, data-redirect="frame" означало «перехода нет вообще».
describe('frameSrc: кто исполняет переход', () => {
  const base: MountOptions = { form: 'opros', mode: 'block' }

  it('по умолчанию параметра нет — уводит хост', () => {
    expect(frameSrc('https://f.trillix.ru', { ...base, redirect: 'top' }, '')).not.toContain(
      'redirect',
    )
  })

  it('redirect=frame доезжает до фрейма', () => {
    expect(frameSrc('https://f.trillix.ru', { ...base, redirect: 'frame' }, '')).toContain(
      'redirect=frame',
    )
  })
})
