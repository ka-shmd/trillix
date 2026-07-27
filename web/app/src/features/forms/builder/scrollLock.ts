// Замок прокрутки на время, пока открыта панель форматирования (фаза 14, этап 14.4;
// решение владельца 2026-07-27).
//
// Зачем: панель стоит на `position: fixed` по координатам выделения, снятым один раз,
// при появлении. Прокрутка увозит текст, а панель остаётся висеть отдельно от того, к
// чему относится.
//
// **Замок НЕ угадывает, какой узел прокручивается, — и это главное.** Первая версия
// вешала `overflow: hidden` на один помеченный контейнер (`<main>` кабинета), и
// страница продолжала скроллиться: класс `overflow-auto` на элементе ещё не означает,
// что прокручивается именно он — если высота не ограничена, элемент растёт по контенту,
// а едет документ. Проверить это тестом нельзя (лэйаута у happy-dom нет), поэтому
// правильный ответ — не выбирать один узел, а закрыть все пути сразу:
//
//   1. `overflow: hidden` на документе, body и помеченном контейнере — что бы из них
//      ни оказалось настоящим скроллером, оно заперто;
//   2. `wheel` и `touchmove` гасятся на фазе перехвата — это покрывает колесо и тач
//      внутри любого вложенного скроллера, до которого замок по overflow не дотянулся.
//
// Клавиатурная прокрутка (PageUp/PageDown, пробел) не гасится намеренно: каретка в этот
// момент в тексте, и эти клавиши принадлежат ему, а не странице.
export function lockScroll(from: HTMLElement): () => void {
  const doc = from.ownerDocument
  const marked = from.closest<HTMLElement>('[data-scroll-root]')
  const targets = [doc.documentElement, doc.body, marked].filter(
    (el): el is HTMLElement => el !== null,
  )

  const restore = targets.map((el) => {
    const prevOverflow = el.style.overflow
    const prevPadding = el.style.paddingRight
    // Компенсация ширины полосы прокрутки: без неё контент прыгает вбок ровно в тот
    // момент, когда автор целится мышью в панель.
    const gap = el.offsetWidth - el.clientWidth
    el.style.overflow = 'hidden'
    if (gap > 0) el.style.paddingRight = `${gap}px`
    return () => {
      el.style.overflow = prevOverflow
      el.style.paddingRight = prevPadding
    }
  })

  // passive: false обязателен — иначе браузер игнорирует preventDefault у wheel/touchmove
  // и замок молча не работает; capture — чтобы успеть раньше вложенных обработчиков.
  const stop = (e: Event) => e.preventDefault()
  const opts = { passive: false, capture: true } as const
  doc.addEventListener('wheel', stop, opts)
  doc.addEventListener('touchmove', stop, opts)

  return () => {
    for (const undo of restore) undo()
    doc.removeEventListener('wheel', stop, opts)
    doc.removeEventListener('touchmove', stop, opts)
  }
}
