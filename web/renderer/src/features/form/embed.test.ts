import { describe, expect, it } from 'vitest'

import {
  applyPrefill,
  createHostBridge,
  readEmbed,
  readPrefill,
  type HostMessage,
} from './embed'

const plain = { hideTitle: false, alignLeft: false, selfScroll: false, preview: false }

describe('readEmbed', () => {
  it('читает режим и прозрачность', () => {
    expect(readEmbed('?embed=block')).toEqual({
      mode: 'block',
      transparent: false,
      redirectSelf: false,
      ...plain,
    })
    expect(readEmbed('?embed=widget&bg=transparent')).toEqual({
      mode: 'widget',
      transparent: true,
      redirectSelf: false,
      ...plain,
    })
    expect(readEmbed('?embed=page')).toEqual({
      mode: 'page',
      transparent: false,
      redirectSelf: false,
      ...plain,
    })
  })

  // Три настройки вставки читаются по точному значению: параметр приходит с чужой
  // страницы, и «почти похоже» не повод менять вид формы или перестать считать визит.
  it('вид и предпросмотр — по точному значению параметра', () => {
    const on = readEmbed('?embed=block&hideTitle=1&align=left&preview=1')
    expect(on?.hideTitle).toBe(true)
    expect(on?.alignLeft).toBe(true)
    expect(on?.preview).toBe(true)
    const off = readEmbed('?embed=block&hideTitle=true&align=start&preview=yes')
    expect(off?.hideTitle).toBe(false)
    expect(off?.alignLeft).toBe(false)
    expect(off?.preview).toBe(false)
  })

  // Панель виджета прокручивает форму внутри фрейма и говорит об этом параметром: от
  // него зависит и прижатый к низу бейдж, и переход к началу нового шага.
  it('scroll=frame — фрейм прокручивает себя сам', () => {
    expect(readEmbed('?embed=widget&scroll=frame')?.selfScroll).toBe(true)
    expect(readEmbed('?embed=widget')?.selfScroll).toBe(false)
    expect(readEmbed('?embed=widget&scroll=1')?.selfScroll).toBe(false)
  })

  it('без параметра — обычная страница', () => {
    expect(readEmbed('')).toBeNull()
    expect(readEmbed('?utm_source=vk')).toBeNull()
  })

  // Параметр приходит с чужой страницы: опечатка не повод менять вид формы,
  // открытой по прямой ссылке.
  it('неизвестный режим — не встроены, а не дефолт', () => {
    expect(readEmbed('?embed=1')).toBeNull()
    expect(readEmbed('?embed=inline')).toBeNull()
    expect(readEmbed('?embed=')).toBeNull()
  })
})

describe('createHostBridge', () => {
  const collect = () => {
    const sent: HostMessage[] = []
    return { sent, post: (m: HostMessage) => sent.push(m) }
  }

  it('сообщает о готовности сразу', () => {
    const { sent, post } = collect()
    createHostBridge('block', post)
    expect(sent).toEqual([{ source: 'trillix', v: 1, type: 'ready' }])
  })

  it('каждое сообщение помечено источником и версией', () => {
    const { sent, post } = collect()
    const bridge = createHostBridge('block', post)
    bridge.resize(400)
    bridge.page(2)
    bridge.submitted('01930000-0000-7000-8000-000000000000')
    bridge.redirect('https://example.org/done')
    expect(sent.every((m) => m.source === 'trillix' && m.v === 1)).toBe(true)
    expect(sent.map((m) => m.type)).toEqual(['ready', 'resize', 'page', 'submit', 'redirect'])
  })

  // Высота меняется на каждый символ в textarea; одинаковое значение хосту не нужно.
  it('одинаковую высоту повторно не шлёт', () => {
    const { sent, post } = collect()
    const bridge = createHostBridge('block', post)
    bridge.resize(400)
    bridge.resize(400)
    bridge.resize(420)
    bridge.resize(420)
    expect(sent.filter((m) => m.type === 'resize')).toEqual([
      { source: 'trillix', v: 1, type: 'resize', height: 400 },
      { source: 'trillix', v: 1, type: 'resize', height: 420 },
    ])
  })

  // Ответы респондента через границу фрейма не уезжают: они у владельца в кабинете,
  // а DOM чужой страницы — лишняя поверхность утечки (design/embed.md §5).
  it('об отправке сообщает только идентификатором', () => {
    const { sent, post } = collect()
    createHostBridge('widget', post).submitted('01930000-0000-7000-8000-000000000000')
    const msg = sent.find((m) => m.type === 'submit')
    expect(msg).toEqual({
      source: 'trillix',
      v: 1,
      type: 'submit',
      submissionId: '01930000-0000-7000-8000-000000000000',
    })
  })
})

describe('readPrefill', () => {
  it('читает значения, подставленные хостом', () => {
    expect(
      readPrefill('?embed=block&pf.blk_1=ivan%40site.ru&pf.blk_2=%D0%98%D0%B2%D0%B0%D0%BD'),
    ).toEqual({
      blk_1: 'ivan@site.ru',
      blk_2: 'Иван',
    })
  })

  it('без предзаполнения — пусто', () => {
    expect(readPrefill('?embed=block&utm_source=vk')).toEqual({})
  })

  // Пустое значение — не ответ: иначе сниппет с незаполненной переменной шаблона
  // молча «отвечал» бы за человека пустой строкой.
  it('пустые значения пропускаются', () => {
    expect(readPrefill('?pf.blk_1=&pf.blk_2=x')).toEqual({ blk_2: 'x' })
  })
})

// Пока флаг не приезжал во фрейм, data-redirect="frame" означало «перехода нет
// вообще»: фрейм слал сообщение, хост его игнорировал, и никто никуда не уходил.
describe('readEmbed: кто исполняет переход после отправки', () => {
  it('по умолчанию — страница-хозяин', () => {
    expect(readEmbed('?embed=block')?.redirectSelf).toBe(false)
  })

  it('redirect=frame — сам фрейм', () => {
    expect(readEmbed('?embed=block&redirect=frame')?.redirectSelf).toBe(true)
  })
})

describe('applyPrefill', () => {
  const anything = () => true

  it('заполняет пустые места черновика', () => {
    expect(applyPrefill({ a: 'своё' }, { a: 'чужое', b: 'подставлено' }, anything)).toEqual({
      a: 'своё',
      b: 'подставлено',
    })
  })

  // Пустая строка в черновике — тоже ответ («стёр подставленное»).
  it('не воскрешает стёртое человеком', () => {
    expect(applyPrefill({ a: '' }, { a: 'подставлено' }, anything)).toEqual({ a: '' })
  })

  // Ключ с чужой страницы, которого нет в ОПУБЛИКОВАННОЙ схеме, уехал бы в ответ,
  // сервер отверг бы ответ целиком («ответ на несуществующий вопрос»), а показать
  // ошибку не на чем — поля нет. Форма стала бы неотправляемой для всех и молча.
  it('отбрасывает ключи, которые нельзя заполнить', () => {
    const known = (id: string) => id === 'blk_known'
    expect(applyPrefill({}, { blk_known: 'x', blk_unknown: 'y' }, known)).toEqual({
      blk_known: 'x',
    })
  })

  it('черновик не мутируется', () => {
    const draft = { a: 'своё' }
    applyPrefill(draft, { b: 'x' }, anything)
    expect(draft).toEqual({ a: 'своё' })
  })
})
