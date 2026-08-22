import { type Span, isHttpUrl } from '@entities/formSchema'

import { useMentionResolver } from './mention'

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
// `carrier` — id блока, которому этот текст принадлежит. Нужен ровно подстановке: без
// него не проверить, что источник стоит ВЫШЕ носителя (mention.ts), а сам текст своего
// блока не знает. Передают его те, кто блок и рисует, — BlockField и контрол согласия.
export function RichText({
  spans,
  inert,
  carrier,
}: {
  spans: Span[] | undefined
  inert?: boolean
  carrier?: string
}) {
  const resolve = useMentionResolver()
  if (!spans?.length) return null
  return (
    <>
      {spans.map((s, i) => {
        const cls = s.m?.length ? s.m.map((m) => `rf-${m}`).join(' ') : undefined
        const style = s.color || s.bg ? { color: s.color, backgroundColor: s.bg } : undefined
        // Подстановка ответа. Разрешает её резолвер поверхности; нет резолвера — кусок
        // печатается своим текстом (именем вопроса), как и в данных. Марки и цвет
        // остаются на подставленном значении: оформление принадлежит куску, а не
        // тому, что в нём написано.
        if (s.ref) {
          const value = resolve ? resolve(s.ref, carrier ?? '') : s.t
          if (!value) return null
          if (!cls && !style) return value
          return (
            <span key={i} className={cls} style={style}>
              {value}
            </span>
          )
        }
        if (s.href && isHttpUrl(s.href)) {
          return (
            <a
              key={i}
              // rf-link — общий вид ссылки (fields.css): цвет акцента и подчёркивание.
              // Без класса <a> достаётся браузерный дефолт, а в кабинете и того нет:
              // сброс Tailwind красит ссылку `inherit`, и в превью она неотличима от
              // текста вокруг.
              className={cls ? `rf-link ${cls}` : 'rf-link'}
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
