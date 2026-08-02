import { COVER_Y_MAX, COVER_Y_MIN } from '@entities/formSchema'

// Математика жеста «изменить положение». Обе функции чистые и потому проверяемые:
// знак, масштаб и края — ровно то, что на глаз выглядит просто «перетаскивание
// работает как-то не так», а тестом формулируется одной строкой.

// coverOverflowPx — на сколько пикселей картинка ПЕРЕРАСТАЕТ полосу по высоте. Это и
// есть весь ход, который у сдвига вообще есть: `object-position: 50% Y%` раскладывает
// по этому перерастанию диапазон 0–100, а не по высоте полосы.
//
// Именно здесь была ошибка первой версии: масштаб брался от высоты полосы, и картинка
// уезжала кратно быстрее курсора — тем сильнее, чем выше снимок (у портрета
// перерастание в разы больше полосы).
//
// При `object-fit: cover` вертикальный ход возможен только тогда, когда картинку
// растянули по ШИРИНЕ, — значит масштаб `bandWidth / naturalWidth`, и высота едет за
// ним. Нет перерастания (панорама шире полосы) — двигать нечего, ход нулевой.
export function coverOverflowPx(
  naturalWidth: number,
  naturalHeight: number,
  bandWidth: number,
  bandHeight: number,
): number {
  // Картинка ещё не загрузилась (natural* по нулям) или полосу не смерили — ход
  // нулевой, а не бесконечный: делить на это нельзя.
  if (naturalWidth <= 0 || naturalHeight <= 0 || bandWidth <= 0) return 0
  const renderedHeight = (naturalHeight * bandWidth) / naturalWidth
  return Math.max(0, renderedHeight - bandHeight)
}

// nextCoverY — точка фокуса после протяжки, в процентах и БЕЗ округления: пока жест
// идёт, картинка должна ехать плавно, а целое (контракт схемы принимает только его)
// берётся один раз, на отпускании. Округляй здесь — и на высоком снимке, где процент
// стоит десяток пикселей, картинка дёргалась бы ступеньками.
//
// Увод указателя ВВЕРХ показывает НИЖНЮЮ часть картинки, поэтому y растёт (отсюда
// startPointerY − pointerY, а не наоборот). Масштаб — перерастание: пиксель курсора
// двигает картинку ровно на пиксель, как и ожидает рука.
export function nextCoverY(
  startY: number,
  startPointerY: number,
  pointerY: number,
  overflowPx: number,
): number {
  if (overflowPx <= 0) return startY
  const next = startY + ((startPointerY - pointerY) * COVER_Y_MAX) / overflowPx
  return Math.min(COVER_Y_MAX, Math.max(COVER_Y_MIN, next))
}
