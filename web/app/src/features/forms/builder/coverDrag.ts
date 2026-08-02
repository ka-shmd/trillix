import { COVER_Y_MAX, COVER_Y_MIN } from '@entities/formSchema'

// nextCoverY — точка фокуса после протяжки. Чистая функция и потому проверяемая:
// знак, масштаб и края — ровно то, что на глаз выглядит «как-то не так», а тестом
// формулируется одной строкой.
//
// Увод указателя ВВЕРХ показывает НИЖНЮЮ часть картинки, поэтому y растёт (отсюда
// startPointerY − pointerY, а не наоборот). Масштаб — высота самой полосы: провёл её
// насквозь, прошёл весь диапазон; так жест соразмерен видимому при любой высоте
// обложки. Нулевая высота (полосу ещё не смерили) не должна давать Infinity.
export function nextCoverY(
  startY: number,
  startPointerY: number,
  pointerY: number,
  bandHeight: number,
): number {
  if (bandHeight <= 0) return startY
  const next = startY + ((startPointerY - pointerY) * COVER_Y_MAX) / bandHeight
  return Math.round(Math.min(COVER_Y_MAX, Math.max(COVER_Y_MIN, next)))
}
