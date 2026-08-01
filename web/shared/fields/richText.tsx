import { type Span, isHttpUrl } from '@entities/formSchema'

// RichText — вывод богатого текста блока (фаза 14, §3.1 спеки). Один `.map`: кусок без
// оформления печатается как есть, оформленный — в <span> с классами булевых марок
// (`rf-b`/`rf-i`/`rf-u`/`rf-s`, вид в fields.css) и inline-стилем цвета; кусок со
// ссылкой — в <a>.
//
// Три правила, каждое куплено раньше и не обсуждается:
//   1. Только React-элементы: инвариант 4 запрещает dangerouslySetInnerHTML во всём
//      репозитории, поэтому экранирование остаётся автоматическим.
//   2. href проверяется ПОВТОРНО здесь, а не только при сохранении, — ровно как
//      redirectUrl: доверять содержимому схемы в точке использования нельзя. Не прошёл
//      проверку — рисуем текст без ссылки, а не битую ссылку.
//   3. Цвет уходит в style, а не в className: значение свободное (ADR §10), React его
//      экранирует, а `#rrggbb` из схемы не оставляет места ни для url(...), ни для
//      наследия expression.
//
// `inert` — блок показывают, но форма не живая (превью билдера). Ссылка тогда рисуется
// ровно так же (вид трёх поверхностей обязан совпадать), но никуда не ведёт: клик по
// ней в превью уводил бы АВТОРА с полотна посреди сборки формы. У респондента
// (`disabled={false}`) ссылка живая — она для него и делалась.
export function RichText({ spans, inert }: { spans: Span[] | undefined; inert?: boolean }) {
  if (!spans?.length) return null
  return (
    <>
      {spans.map((s, i) => {
        const cls = s.m?.length ? s.m.map((m) => `rf-${m}`).join(' ') : undefined
        const style = s.color || s.bg ? { color: s.color, backgroundColor: s.bg } : undefined
        if (s.href && isHttpUrl(s.href)) {
          return (
            <a
              key={i}
              className={cls}
              style={style}
              href={s.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={inert ? (e) => e.preventDefault() : undefined}
            >
              {s.t}
            </a>
          )
        }
        if (!cls && !style) return s.t
        return (
          <span key={i} className={cls} style={style}>
            {s.t}
          </span>
        )
      })}
    </>
  )
}
