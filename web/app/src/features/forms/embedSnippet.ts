import { isAnswerableType, plainText, type Block } from '@entities/formSchema'

// Сборка кода для вставки формы на чужой сайт (фаза 20). Чистые функции: экран
// «Встроить» только показывает то, что здесь собрано, а юниты проверяют главное —
// что сниппет ведёт туда же, куда публичная ссылка, и что пользовательский текст
// не ломает разметку у владельца сайта.
//
// Настройки вставки нигде не сохраняются (решение владельца 2026-08-05): они живут
// в самом сниппете, на чужой странице, и правятся там же.

export type EmbedMode = 'block' | 'widget' | 'page'
export type WidgetPosition = 'bottom-right' | 'bottom-left'

export interface SnippetOptions {
  /** База публичной части — та же, что у ссылки на форму (publicUrl.ts). */
  baseUrl: string
  slug: string
  mode: EmbedMode
  /** Надпись на кнопке виджета: вводит владелец формы, поэтому экранируется. */
  label?: string
  position?: WidgetPosition
  transparent?: boolean
  /** Высота простого iframe: у него авторесайза нет, размер задаётся сразу. */
  height?: number
}

/** Высота простого `<iframe>` без загрузчика: подстраиваться ему нечем. */
export const PLAIN_IFRAME_HEIGHT = 720

const loaderUrl = (baseUrl: string) => `${baseUrl}/embed/v1.js`

// Значение уезжает в HTML-атрибут на чужой странице. Кавычка в надписи кнопки
// («Оставить "заявку"») иначе оборвала бы атрибут и превратила остаток сниппета в
// мусор — на сайте, куда мы попасть уже не сможем.
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Сниппет с загрузчиком — один тег, без парного div. */
export function scriptSnippet(opts: SnippetOptions): string {
  const attrs: string[] = []
  if (opts.mode === 'widget') {
    attrs.push(`data-trillix-widget="${escapeAttr(opts.slug)}"`)
    if (opts.label) attrs.push(`data-label="${escapeAttr(opts.label)}"`)
    if (opts.position === 'bottom-left') attrs.push('data-position="bottom-left"')
  } else {
    attrs.push(`data-trillix-form="${escapeAttr(opts.slug)}"`)
    if (opts.mode === 'page') attrs.push('data-mode="page"')
    if (opts.transparent) attrs.push('data-bg="transparent"')
  }
  return `<script src="${loaderUrl(opts.baseUrl)}" ${attrs.join(' ')} async></script>`
}

/**
 * Сниппет без загрузчика — голый `<iframe>`.
 *
 * Не запасной путь, а полноценный режим: сайт со строгой CSP (`script-src 'self'`)
 * наш скрипт не подключит вовсе, и таких среди корпоративных CMS достаточно. Цена
 * известна и показывается рядом: высота фиксированная, виджета не существует.
 */
export function iframeSnippet(opts: SnippetOptions): string {
  const params = new URLSearchParams({ embed: opts.mode === 'widget' ? 'block' : opts.mode })
  if (opts.transparent) params.set('bg', 'transparent')
  const src = `${opts.baseUrl}/r/${encodeURIComponent(opts.slug)}?${params.toString()}`
  const height = opts.mode === 'page' ? '100%' : String(opts.height ?? PLAIN_IFRAME_HEIGHT)
  return `<iframe src="${escapeAttr(src)}" title="Форма" width="100%" height="${height}" style="border:0"></iframe>`
}

/** Одно предзаполняемое поле: id блока и подпись, которой вопрос назван в форме. */
export interface PrefillField {
  blockId: string
  caption: string
}

/**
 * prefillFields — вопросы формы, которые хост может заполнить заранее.
 *
 * Только отвечаемые блоки: у подписи и картинки ответа нет, заполнять нечего.
 * Подпись берётся из группы вопроса — той же строки, которой вопрос назван в CSV.
 */
export function prefillFields(blocks: Block[]): PrefillField[] {
  const captions = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'title' && block.type !== 'label') continue
    const text = plainText(block.text).trim()
    if (text && !captions.has(block.groupId)) captions.set(block.groupId, text)
  }
  return blocks
    .filter((block) => isAnswerableType(block.type))
    .map((block) => ({
      blockId: block.id,
      caption: captions.get(block.groupId) ?? 'Без заголовка',
    }))
}

/**
 * prefillSnippet — готовый вызов с объектом предзаполнения.
 *
 * Отдаём объект ЦЕЛИКОМ, со всеми полями и подписями в комментариях: ключ — id
 * блока (`blk_` + UUID), и собирать его по одному из интерфейса было бы мучением.
 * Скопировал, вписал свои переменные, лишние строки удалил.
 */
export function prefillSnippet(opts: SnippetOptions, fields: PrefillField[]): string {
  const lines = fields.map((f) => `    '${f.blockId}': '', // ${f.caption}`)
  const body = lines.length > 0 ? `\n  prefill: {\n${lines.join('\n')}\n  },` : ''
  return `Trillix.open({\n  form: '${opts.slug}',\n  mode: '${opts.mode}',${body}\n})`
}
