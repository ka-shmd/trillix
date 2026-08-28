import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CENTER_WIDTH,
  DEFAULT_HEIGHT,
  DEFAULT_LABEL,
  DEFAULT_WIDTH,
  frameAdoption,
  frameSrc,
  isHttpUrl,
  optionsFromAttrs,
  readFrameMessage,
  scriptOrigin,
  type MountOptions,
  type WidgetPosition,
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

  it('настройки вида и предпросмотр доезжают до фрейма', () => {
    const src = frameSrc(
      'https://f.trillix.ru',
      { ...base, hideTitle: true, alignLeft: true, preview: true },
      '',
    )
    expect(src).toContain('hideTitle=1')
    expect(src).toContain('align=left')
    expect(src).toContain('preview=1')
    // Выключенные настройки в адресе не появляются вовсе: параметр читается
    // рендерером как «сказано явно», и «hideTitle=0» стоил бы лишней ветки.
    expect(frameSrc('https://f.trillix.ru', base, '')).not.toContain('hideTitle')
    expect(frameSrc('https://f.trillix.ru', base, '')).not.toContain('preview')
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
      hideTitle: false,
      alignLeft: false,
      preview: false,
      dynamicHeight: true,
      width: DEFAULT_WIDTH,
      overlay: true,
      open: 'click',
      openValue: 0,
      hideOnSubmit: false,
      button: true,
    })
  })

  // УМОЛЧАНИЯ ВКЛЮЧЕНЫ, И ЭТО НЕ ВКУС: сниппеты, вставленные на чужие сайты до
  // появления этих атрибутов, их не несут — прочитай мы отсутствие как «выключено»,
  // у живых вставок разом пропали бы авторесайз и затемнение под модалкой.
  it('живая высота и подложка выключаются только явным значением', () => {
    const on = optionsFromAttrs(attrs({ 'data-trillix-form': 'a' }))
    expect(on?.dynamicHeight).toBe(true)
    expect(on?.overlay).toBe(true)
    const off = optionsFromAttrs(
      attrs({ 'data-trillix-form': 'a', 'data-dynamic-height': '0', 'data-overlay': 'none' }),
    )
    expect(off?.dynamicHeight).toBe(false)
    expect(off?.overlay).toBe(false)
  })

  it('четыре угла кнопки, неизвестный — правый нижний', () => {
    const corner = (value: string) =>
      optionsFromAttrs(attrs({ 'data-trillix-widget': 'a', 'data-position': value }))?.position
    expect(corner('top-left')).toBe('top-left')
    expect(corner('top-right')).toBe('top-right')
    expect(corner('bottom-left')).toBe('bottom-left')
    expect(corner('справа')).toBe('bottom-right')
  })

  it('триггер открытия: известный — как написан, чужой — клик', () => {
    const trigger = (value: string) =>
      optionsFromAttrs(attrs({ 'data-trillix-widget': 'a', 'data-open': value }))?.open
    expect(trigger('delay')).toBe('delay')
    expect(trigger('scroll')).toBe('scroll')
    expect(trigger('exit')).toBe('exit')
    expect(trigger('hover')).toBe('click')
    expect(optionsFromAttrs(attrs({ 'data-trillix-widget': 'a' }))?.open).toBe('click')
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

  // Настройки вида вставки: обе выключены, пока не сказано ровно «1» и «left», —
  // мусор в атрибуте не должен молча менять вид формы на чужой странице.
  it('заголовок и выравнивание — только по явному значению', () => {
    const opts = optionsFromAttrs(
      attrs({ 'data-trillix-form': 'a', 'data-hide-title': '1', 'data-align': 'left' }),
    )
    expect(opts?.hideTitle).toBe(true)
    expect(opts?.alignLeft).toBe(true)
    const junk = optionsFromAttrs(
      attrs({ 'data-trillix-form': 'a', 'data-hide-title': 'да', 'data-align': 'центр' }),
    )
    expect(junk?.hideTitle).toBe(false)
    expect(junk?.alignLeft).toBe(false)
  })

  // Предпросмотр — флаг кабинета, а не сниппета: в коде, который получает владелец
  // сайта, его нет, поэтому обычная вставка обязана читаться как «не предпросмотр».
  it('предпросмотр — только по data-preview="1"', () => {
    expect(
      optionsFromAttrs(attrs({ 'data-trillix-form': 'a', 'data-preview': '1' }))?.preview,
    ).toBe(true)
    expect(optionsFromAttrs(attrs({ 'data-trillix-form': 'a' }))?.preview).toBe(false)
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

describe('frameAdoption', () => {
  const ORIGIN = 'https://f.trillix.ru'
  const adopt = (address: string | null, map: Record<string, string> = {}) =>
    frameAdoption(ORIGIN, address, attrs(map), '')

  it('поднимает фрейм по адресу своего origin', () => {
    const got = adopt(`${ORIGIN}/r/opros?embed=block`)
    expect(got?.src).toBe(`${ORIGIN}/r/opros?embed=block`)
    expect(got?.opts).toMatchObject({ form: 'opros', mode: 'block', dynamicHeight: true })
  })

  // Загрузчик не универсальный подъёмник фреймов: адрес пишут в разметке чужой
  // страницы, и чужой origin оттуда поднимать нельзя.
  it('чужой origin, битый адрес и путь не /r/ — не наш фрейм', () => {
    expect(adopt('https://evil.example/r/opros?embed=block')).toBeNull()
    expect(adopt('javascript:alert(1)')).toBeNull()
    expect(adopt(`${ORIGIN}/embed/v1.js`)).toBeNull()
    expect(adopt(`${ORIGIN}/r/`)).toBeNull()
    expect(adopt(null)).toBeNull()
  })

  // Пустой origin — загрузчик не смог прочитать собственный адрес; поднимать некуда.
  it('без origin загрузчика фрейм не поднимается', () => {
    expect(frameAdoption('', `${ORIGIN}/r/opros?embed=block`, attrs({}), '')).toBeNull()
  })

  it('режим читается из адреса, а не из атрибутов', () => {
    expect(adopt(`${ORIGIN}/r/opros?embed=page`)?.opts.mode).toBe('page')
    // Виджет фреймом в потоке быть не может — ведёт себя как блок.
    expect(adopt(`${ORIGIN}/r/opros?embed=widget`)?.opts.mode).toBe('block')
  })

  // Метки источника лендинга в кабинете неизвестны — их добавляет загрузчик, ровно
  // как и в адресе, который он собирает сам (frameSrc).
  it('подставляет метки источника хост-страницы', () => {
    const got = frameAdoption(
      ORIGIN,
      `${ORIGIN}/r/opros?embed=block`,
      attrs({}),
      '?utm_source=vk&ref=x',
    )
    expect(got?.src).toContain('utm_source=vk')
    expect(got?.src).not.toContain('ref=x')
  })

  it('метку, уже написанную в адресе, не переписывает', () => {
    const got = frameAdoption(
      ORIGIN,
      `${ORIGIN}/r/opros?embed=block&utm_source=letter`,
      attrs({}),
      '?utm_source=vk',
    )
    expect(got?.src).toContain('utm_source=letter')
    expect(got?.src).not.toContain('utm_source=vk')
  })

  it('высота — из атрибута фрейма, мусор даёт умолчание', () => {
    expect(adopt(`${ORIGIN}/r/opros?embed=block`, { height: '900' })?.opts.height).toBe(900)
    expect(adopt(`${ORIGIN}/r/opros?embed=block`, { height: '100%' })?.opts.height).toBe(
      DEFAULT_HEIGHT,
    )
  })

  it('data-dynamic-height="0" останавливает подстройку высоты', () => {
    const off = { 'data-dynamic-height': '0' }
    expect(adopt(`${ORIGIN}/r/opros?embed=block`, off)?.opts.dynamicHeight).toBe(false)
  })
})

describe('optionsFromAttrs: кнопка сайта', () => {
  // С 2026-08-28 кабинет печатает настройки атрибутами на ЧУЖОЙ кнопке: без разбора
  // этих атрибутов форма открывалась бы с умолчаниями, а не так, как её настроили.
  it('data-trillix-open читается как виджет, вместе с настройками вида', () => {
    const opts = optionsFromAttrs(
      attrs({
        'data-trillix-open': 'opros',
        'data-position': 'center',
        'data-width': '700',
        'data-overlay': 'none',
      }),
    )
    expect(opts).toMatchObject({
      form: 'opros',
      mode: 'widget',
      position: 'center',
      width: 700,
      overlay: false,
    })
  })

  // Кнопка, размеченная одним атрибутом (так делали до появления настроек на ней),
  // обязана открывать форму с умолчаниями, а не молчать.
  it('кнопка с одним атрибутом — умолчания', () => {
    expect(optionsFromAttrs(attrs({ 'data-trillix-open': 'opros' }))).toMatchObject({
      form: 'opros',
      mode: 'widget',
      position: 'bottom-right',
      width: DEFAULT_WIDTH,
    })
  })
})

describe('optionsFromAttrs: своя кнопка загрузчика', () => {
  // ОТСУТСТВИЕ АТРИБУТА = РИСОВАТЬ. Вставки, стоящие на чужих сайтах с прошлых
  // месяцев, `data-button` не несут; прочитай мы его отсутствие как «не рисовать» —
  // форма разом стала бы на них недоступной.
  it('без атрибута кнопка рисуется', () => {
    expect(optionsFromAttrs(attrs({ 'data-trillix-widget': 'opros' }))?.button).toBe(true)
  })

  it('data-button="none" — кнопки нет', () => {
    const opts = optionsFromAttrs(attrs({ 'data-trillix-widget': 'opros', 'data-button': 'none' }))
    expect(opts?.button).toBe(false)
  })
})

describe('ширина и скролл — по расположению', () => {
  const widget = (map: Record<string, string> = {}) =>
    optionsFromAttrs(attrs({ 'data-trillix-widget': 'opros', ...map }))
  const widgetSrc = (position?: WidgetPosition) =>
    frameSrc('https://f.trillix.ru', { form: 'opros', mode: 'widget', position }, '')

  // Умолчание ширины у угла и у центра разное (решение владельца 2026-08-28), и
  // кабинет на это опирается: `data-width` он пишет, только когда автор отошёл от
  // умолчания СВОЕГО расположения. Сойдись оба умолчания к 376 — окно по центру
  // молча стало бы панелью.
  it('окно по центру шире панели в углу', () => {
    expect(widget()?.width).toBe(DEFAULT_WIDTH)
    expect(widget({ 'data-position': 'center' })?.width).toBe(DEFAULT_CENTER_WIDTH)
  })

  it('data-width перебивает умолчание любого расположения', () => {
    expect(widget({ 'data-position': 'center', 'data-width': '480' })?.width).toBe(480)
  })

  // `scroll=frame` говорит фрейму, что низ у него постоянный: по этому параметру
  // рендерер прижимает бейдж площадки к нижнему краю панели.
  it('панель в углу прокручивает форму внутри фрейма, окно по центру — нет', () => {
    expect(widgetSrc()).toContain('scroll=frame')
    expect(widgetSrc('bottom-left')).toContain('scroll=frame')
    expect(widgetSrc('center')).not.toContain('scroll=frame')
  })

  it('блок и страница прокручивают хоста — параметра нет', () => {
    expect(frameSrc('https://f.trillix.ru', { form: 'opros', mode: 'block' }, '')).not.toContain(
      'scroll',
    )
    expect(frameSrc('https://f.trillix.ru', { form: 'opros', mode: 'page' }, '')).not.toContain(
      'scroll',
    )
  })
})

describe('optionsFromAttrs: расположение', () => {
  const position = (value: string) =>
    optionsFromAttrs(attrs({ 'data-trillix-widget': 'opros', 'data-position': value }))?.position

  it('центр — новое значение контракта', () => {
    expect(position('center')).toBe('center')
  })

  // Четыре угла остаются контрактом v1: кабинет их больше не предлагает, но вставки
  // с ними живут на чужих сайтах.
  it('прежние углы продолжают читаться', () => {
    expect(position('top-left')).toBe('top-left')
    expect(position('bottom-left')).toBe('bottom-left')
  })

  it('опечатка — правый нижний угол, а не потерянная форма', () => {
    expect(position('centre')).toBe('bottom-right')
  })
})
