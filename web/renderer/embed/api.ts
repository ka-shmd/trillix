// Чистая часть загрузчика (фаза 20): всё, что можно решить без DOM, — адрес фрейма,
// разбор data-атрибутов сниппета, проброс меток источника, проверка ссылки перехода.
//
// Разделение не косметическое: у рендерера нет testing-library (список зависимостей
// заморожен), поэтому проверяется юнитами ровно то, что живёт здесь, — а живёт здесь
// всё, где можно ошибиться молча. В v1.ts остаются только сборка узлов и подписки.

/** Как форма показана на чужой странице. Виджет и страница приезжают шагами 3–4. */
export type EmbedMode = 'block'

export interface MountOptions {
  /** Короткий адрес формы, тот же, что в публичной ссылке. */
  form: string
  mode: EmbedMode
  /** Фон формы прозрачен — блок ложится на фон сайта, а не белым прямоугольником. */
  transparent?: boolean
  /** Высота до первого сообщения о размере: без неё блок прыгал бы с нуля. */
  height?: number
  /** Кто уходит по ссылке после отправки: 'top' — страница-хозяин, 'frame' — сам фрейм. */
  redirect?: 'top' | 'frame'
}

/** Высота фрейма до первого `resize`. Форма из пары вопросов примерно столько и занимает. */
export const DEFAULT_HEIGHT = 520

// Метки источника — закрытый список, тот же, что у рендерера и сервера. Произвольные
// параметры чужой страницы в аналитику не уезжают.
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']

/**
 * scriptOrigin — откуда грузиться форме: из адреса самого загрузчика.
 *
 * Захардкоженный домен сделал бы файл непроверяемым: на prod-local он тот же
 * `embed/v1.js`, но с `f.localhost`, и сниппет молча ходил бы в прод. Возвращает
 * пустую строку на нечитаемом адресе — вызывающий тогда просто ничего не делает.
 */
export function scriptOrigin(src: string): string {
  try {
    return new URL(src).origin
  } catch {
    return ''
  }
}

/**
 * frameSrc — адрес страницы формы во фрейме.
 *
 * Метки источника берутся с ХОСТ-страницы: внутри фрейма `location.search` — это уже
 * наш адрес, и без проброса utm-метки чужого лендинга не доехали бы до аналитики
 * никогда (та же причина, по которой их читает рендерер, а не сервер).
 */
export function frameSrc(origin: string, opts: MountOptions, hostSearch: string): string {
  const params = new URLSearchParams()
  params.set('embed', opts.mode)
  if (opts.transparent) params.set('bg', 'transparent')
  const host = new URLSearchParams(hostSearch)
  for (const key of UTM_KEYS) {
    const value = host.get(key)
    if (value) params.set(key, value)
  }
  return origin + '/r/' + encodeURIComponent(opts.form) + '?' + params.toString()
}

/** Источник значений сниппета: сам тег `<script>` или контейнер с data-атрибутами. */
export interface AttrSource {
  getAttribute(name: string): string | null
}

/**
 * optionsFromAttrs — настройки вставки из data-атрибутов; null = это не наш узел.
 *
 * Настройки живут только здесь, на чужой странице, и никогда на сервере (решение
 * владельца 2026-08-05): одна форма может быть вставлена в трёх местах по-разному, и
 * серверная копия настроек всякий раз спорила бы с двумя другими вставками.
 */
export function optionsFromAttrs(el: AttrSource): MountOptions | null {
  const form = el.getAttribute('data-trillix-form')
  if (form === null || form === '') return null
  const height = Number(el.getAttribute('data-height'))
  return {
    form,
    mode: 'block',
    transparent: el.getAttribute('data-bg') === 'transparent',
    // Мусор в атрибуте (пусто, «500px», «много») — не повод схлопнуть блок в ноль.
    height: Number.isFinite(height) && height > 0 ? height : DEFAULT_HEIGHT,
    redirect: el.getAttribute('data-redirect') === 'frame' ? 'frame' : 'top',
  }
}

/**
 * isHttpUrl — можно ли уводить сюда страницу-хозяина.
 *
 * Ссылку уже проверил сервер при публикации и ещё раз рендерер перед отправкой
 * сообщения, но она прилетает через границу фрейма и уходит в `location.assign` на
 * ЧУЖОЙ странице — доверять ей на месте использования нельзя (инвариант 4).
 */
export function isHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Сообщение фрейма, прошедшее проверку формы. Зеркалит HostMessage рендерера. */
export type FrameMessage =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'page'; index: number }
  | { type: 'submit'; submissionId: string }
  | { type: 'redirect'; url: string }

/**
 * readFrameMessage — разбор `event.data`; null, если это не наше сообщение.
 *
 * На чужой странице в `message` прилетает чужой трафик — чаты, аналитика, расширения
 * браузера, — поэтому проверяются и метка источника, и версия, и форма полей. Проверка
 * origin остаётся на вызывающем: она про доверие, а не про разбор.
 */
export function readFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const msg = data as Record<string, unknown>
  if (msg.source !== 'trillix' || msg.v !== 1) return null
  switch (msg.type) {
    case 'ready':
      return { type: 'ready' }
    case 'resize':
      return typeof msg.height === 'number' && msg.height > 0
        ? { type: 'resize', height: msg.height }
        : null
    case 'page':
      return typeof msg.index === 'number' ? { type: 'page', index: msg.index } : null
    case 'submit':
      return typeof msg.submissionId === 'string'
        ? { type: 'submit', submissionId: msg.submissionId }
        : null
    case 'redirect':
      return isHttpUrl(msg.url) ? { type: 'redirect', url: msg.url } : null
    default:
      return null
  }
}
