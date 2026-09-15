package domain

import "fmt"

// isScaleLike — ответ это деление ряда: шкала (min..max) и рейтинг (1..число звёзд).
// Оба проверяются одним validateScaleAnswer, сравниваются в условиях числом и сводятся
// распределением по всем делениям. Предикатом, а не сравнением с BlockScale по месту:
// забытая ветка трактовала бы рейтинг как свободный текст.
func (t BlockType) isScaleLike() bool { return t == BlockScale || t == BlockRating }

// ratingStars — число звёзд рейтинга; ноль в настройках читается как дефолт. Зеркалит
// ratingCount на фронте.
func ratingStars(b Block) int {
	if b.Settings.RatingStars == 0 {
		return DefaultRatingStars
	}
	return b.Settings.RatingStars
}

// validateRatingSettings — число звёзд: только у рейтинга (как диапазон у шкалы), ноль
// законен у любого типа — это «не задано».
func validateRatingSettings(b Block) error {
	n := b.Settings.RatingStars
	if n == 0 {
		return nil
	}
	if b.Type != BlockRating {
		return fmt.Errorf("тип %q не имеет звёзд", b.Type)
	}
	if n < RatingStarsMin || n > RatingStarsMax {
		return fmt.Errorf("рейтинг: число звёзд вне [%d, %d]", RatingStarsMin, RatingStarsMax)
	}
	return nil
}
