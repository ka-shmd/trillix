import { AXIS, bandBox, selectionRect } from './canvas'

// Подсказка во время протяжки — ПРЯМОУГОЛЬНИК, а не непрерывный отрезок.
//
// Библиотека рисует по слайсу на день и позиционирует их inline (`top`/`height` в
// пикселях): первый день от начала протяжки до низа, средние целиком, последний
// сверху до курсора. Автор видел одно, а получал другое (canvas.ts, selectionRect).
//
// Правится это двумя переменными на контейнере полотна, которыми правило в
// `canvas.css` переписывает позицию обёртки слайса. Живёт отдельным модулем, потому
// что нужно ОБЕИМ поверхностям — и правилу, и календарю.
//
// Императивно, а не состоянием React: подсказка перерисовывается на каждое движение
// мыши, и гонять через перерисовку всего полотна на каждый кадр заведомо рвано.

export function paintBand(el: HTMLElement | null, startStr: string, endStr: string) {
  if (!el) return
  const rect = selectionRect(startStr, endStr)
  const lane = el.querySelector('.sc-lane')
  // Один день библиотека и так рисует верно — переписывать нечего.
  if (!rect || rect.dates.length < 2 || !lane) {
    clearBand(el)
    return
  }
  // Пиксели, а не проценты: колонка — это ровно ось часов, и её высота меряется по
  // месту. Считать проценты от времени пришлось бы, зная, что колонка нигде не
  // обрезана; замер честнее.
  const box = bandBox(rect.window, AXIS, lane.clientHeight)
  if (!box) {
    clearBand(el)
    return
  }
  el.style.setProperty('--sc-band-top', `${box.top}px`)
  el.style.setProperty('--sc-band-h', `${box.height}px`)
  el.dataset.scBand = ''
}

export function clearBand(el: HTMLElement | null) {
  delete el?.dataset.scBand
}
