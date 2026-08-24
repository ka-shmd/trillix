package postgres

import (
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/domain"
)

// PeriodBounds переводит окно наблюдения в границы SQL-запроса.
//
// Нулевая граница домена («всё время») становится ±бесконечностью, а не
// отсутствующим условием: у запроса остаётся одна форма и один план вместо двух
// веток, а диапазонной проверке по индексу бесконечность не мешает.
//
// Один хелпер на все модули аналитики намеренно: половина интервала здесь
// закрытая, а половина открытая ([from, to)), и разъехавшиеся копии этого правила
// давали бы визит, посчитанный в двух периодах сразу.
func PeriodBounds(p domain.Period) (from, to pgtype.Timestamptz) {
	from = pgtype.Timestamptz{InfinityModifier: pgtype.NegativeInfinity, Valid: true}
	to = pgtype.Timestamptz{InfinityModifier: pgtype.Infinity, Valid: true}
	if !p.From.IsZero() {
		from = pgtype.Timestamptz{Time: p.From, Valid: true}
	}
	if !p.To.IsZero() {
		to = pgtype.Timestamptz{Time: p.To, Valid: true}
	}
	return from, to
}
