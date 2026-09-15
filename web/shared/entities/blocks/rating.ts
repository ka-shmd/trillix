import { type BlockKindContract, type SchemaIssue } from './contract'
import { DEFAULT_RATING_STARS, RATING_STARS_MAX, RATING_STARS_MIN } from './limits'
import { scaleRange } from './scale'
import { type Settings } from './settings'

// ratingCount — число звёзд блока. Ноль и отсутствие ключа значат одно — дефолт: звёзд
// меньше RATING_STARS_MIN не бывает, а Go хранит ключ int с omitempty. Зеркалит
// ratingStars в Go.
export const ratingCount = (b: { settings?: { ratingStars?: number } }): number =>
  b.settings?.ratingStars || DEFAULT_RATING_STARS

// markRange — диапазон ответа у типов с рядом делений: шкала (min..max из настроек) и
// рейтинг (1..число звёзд). Общий для проверки ответа и значений условия логики.
// Зеркалит scaleRange в Go, который знает оба типа.
export const markRange = (b: {
  type: string
  settings?: { scaleMin?: number; scaleMax?: number; ratingStars?: number }
}): { min: number; max: number } =>
  b.type === 'rating' ? { min: 1, max: ratingCount(b) } : scaleRange(b)

const ratingIssues = (s: Settings): SchemaIssue[] => {
  const n = s.ratingStars
  if (!n) return []
  if (n < RATING_STARS_MIN || n > RATING_STARS_MAX) {
    return [
      {
        message: `рейтинг: число звёзд вне [${RATING_STARS_MIN}, ${RATING_STARS_MAX}]`,
        path: ['settings', 'ratingStars'],
      },
    ]
  }
  return []
}

// Рейтинг — ряд звёзд от 1 до N. Ответ хранится строкой с числом, как у шкалы, и
// в условиях и сводке ведёт себя как шкала.
export const rating: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: ['ratingStars'],
  supportsPlaceholder: false,
  // Звёзды без вопроса не читаются, как и ряд делений шкалы.
  requiresCaption: true,
  issues: ratingIssues,
}
