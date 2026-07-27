// Замок прокрутки на время, пока открыта панель форматирования (фаза 14, этап 14.4;
// решение владельца 2026-07-27).
//
// Зачем вообще: панель стоит на `position: fixed` по координатам выделения, снятым в
// момент его появления. Прокрутка увозит текст, а панель остаётся — она «отклеивается»
// от того, к чему относится. Альтернатива замку — пересчитывать позицию на каждом
// кадре прокрутки; владелец выбрал замок.
//
// Замок вешается на РЕАЛЬНЫЙ контейнер прокрутки, а не на `body`: кабинет скроллит
// `<main data-scroll-root>` (routes/_app.tsx), и `body { overflow: hidden }` не сделал
// бы ровно ничего. Контейнер помечен атрибутом, а не вычисляется по computed-стилю:
// явная метка тестируема и сама себя объясняет, а нюх по `overflow-y` ломается молча,
// когда лэйаут меняют.
export function lockScroll(from: HTMLElement): () => void {
  const doc = from.ownerDocument
  const el = from.closest<HTMLElement>('[data-scroll-root]') ?? doc.body
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
}
