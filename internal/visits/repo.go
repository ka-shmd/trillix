package visits

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/geo"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Repo — доступ к данным form_visits поверх sqlc. Методы принимают исполнителя
// (postgres.DBTX: пул или транзакция); транзакций сам не открывает.
type Repo struct{}

// UpsertVisit пишет визит или двигает его вперёд (см. queries.sql: обновляются
// ровно last_block_id и seq, и только при большем seq той же формы). Отсутствие
// эффекта — штатный исход (бикон приехал не по порядку), а не ошибка: отличать их
// вызывающему незачем, поэтому число строк наружу не отдаётся.
func (Repo) UpsertVisit(ctx context.Context, db postgres.DBTX, id, formID, versionID uuid.UUID, lastBlockID *string, seq int16, meta json.RawMessage, place geo.Place, visitorKey []byte) error {
	block := pgtype.Text{}
	if lastBlockID != nil {
		block = pgtype.Text{String: *lastBlockID, Valid: true}
	}
	err := postgres.New(db).UpsertFormVisit(ctx, postgres.UpsertFormVisitParams{
		ID:            id,
		FormID:        formID,
		FormVersionID: versionID,
		LastBlockID:   block,
		Seq:           seq,
		Meta:          meta,
		// Место не определено → NULL, а не пустая строка: «не знаем» обязано иметь
		// ровно одно представление, иначе оно расползётся по спискам пустой строкой.
		CountryCode: nullText(place.CountryCode),
		Country:     nullText(place.Country),
		City:        nullText(place.City),
		VisitorKey:  visitorKey, // nil = ключа нет: визит в счёт уникальных не идёт
	})
	if err != nil {
		return fmt.Errorf("upsert form visit: %w", err)
	}
	return nil
}

// MarkSubmitted отмечает визит как закончившийся ответом. Возвращает число
// затронутых строк: 0 означает «визита нет» (бикон потерялся, id подделан) — для
// вызывающего это не ошибка, ответ уже принят.
func (Repo) MarkSubmitted(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).MarkVisitSubmitted(ctx, postgres.MarkVisitSubmittedParams{ID: id, FormID: formID})
	if err != nil {
		return 0, fmt.Errorf("mark visit submitted: %w", err)
	}
	return n, nil
}

// InsertPage пишет строку пути визита. Нет визита этой формы или строка уже есть —
// ноль строк, и это не ошибка: первое открытие страницы уже записано либо визит
// чужой.
func (Repo) InsertPage(ctx context.Context, db postgres.DBTX, visitID, formID uuid.UUID, blockID string) error {
	err := postgres.New(db).InsertVisitPage(ctx, postgres.InsertVisitPageParams{
		BlockID:  blockID,
		VisitID:  visitID,
		FormID:   formID,
		MaxPages: domain.MaxBlocks, // страниц не бывает больше, чем блоков
	})
	if err != nil {
		return fmt.Errorf("insert visit page: %w", err)
	}
	return nil
}

// CountPaths — визиты с путём по дальней точке, исходу и набору открытых страниц.
func (Repo) CountPaths(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period, f domain.VisitFilter) ([]domain.PathCount, error) {
	from, to := postgres.PeriodBounds(period)
	kind, keys := segParams(f)
	rows, err := postgres.New(db).CountVisitPaths(ctx, postgres.CountVisitPathsParams{FormID: formID, FromTs: from, ToTs: to, SegKind: kind, SegKeys: keys})
	if err != nil {
		return nil, fmt.Errorf("count visit paths: %w", err)
	}
	out := make([]domain.PathCount, len(rows))
	for i, r := range rows {
		out[i] = domain.PathCount{
			LastBlockID: r.LastBlockID.String,
			Submitted:   r.Submitted,
			Blocks:      r.Blocks,
			Visits:      int(r.Visits),
		}
	}
	return out, nil
}

// PageSpans — гистограммы времени на страницах (см. VisitPageDurations).
func (Repo) PageSpans(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period, f domain.VisitFilter) ([]domain.PageSpan, error) {
	from, to := postgres.PeriodBounds(period)
	kind, keys := segParams(f)
	rows, err := postgres.New(db).VisitPageDurations(ctx, postgres.VisitPageDurationsParams{FormID: formID, FromTs: from, ToTs: to, SegKind: kind, SegKeys: keys})
	if err != nil {
		return nil, fmt.Errorf("visit page durations: %w", err)
	}
	out := make([]domain.PageSpan, len(rows))
	for i, r := range rows {
		out[i] = domain.PageSpan{
			PageBlock: r.PageBlock,
			LastBlock: r.LastBlock,
			Left:      r.LeftHere,
			Sec:       int(r.Sec),
			Visits:    int(r.Visits),
		}
	}
	return out, nil
}

// VersionStats — визиты по версиям формы за окно (спека design/analytics-v2.md §5.3).
// Ключ карты — id версии: номер и дату публикации знает модуль форм.
func (Repo) VersionStats(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period, f domain.VisitFilter) (map[uuid.UUID]domain.VersionStat, error) {
	from, to := postgres.PeriodBounds(period)
	kind, keys := segParams(f)
	rows, err := postgres.New(db).VisitVersionStats(ctx, postgres.VisitVersionStatsParams{FormID: formID, FromTs: from, ToTs: to, SegKind: kind, SegKeys: keys})
	if err != nil {
		return nil, fmt.Errorf("visit version stats: %w", err)
	}
	out := make(map[uuid.UUID]domain.VersionStat, len(rows))
	for _, r := range rows {
		out[r.FormVersionID] = domain.VersionStat{
			Visits:                int(r.Visits),
			Submitted:             int(r.Submitted),
			TimedCompletions:      int(r.TimedCompletions),
			CompletionDurationSec: r.CompletionDurationSec,
		}
	}
	return out, nil
}

// segParams — сегмент в параметры запроса. Нет сегмента — оба NULL, и условие в SQL
// отключено; сегмент без подходящих значений — пустой массив, и визитов ноль.
func segParams(f domain.VisitFilter) (pgtype.Text, []string) {
	if f.IsZero() {
		return pgtype.Text{}, nil
	}
	keys := f.Keys
	if keys == nil {
		keys = []string{}
	}
	return pgtype.Text{String: string(f.Kind), Valid: true}, keys
}

// nullText — пустая строка становится NULL.
func nullText(s string) pgtype.Text {
	if s == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: s, Valid: true}
}

// CountByLastBlock — раскладка визитов по самой дальней точке (сырьё воронки).
// Пустой BlockID — визиты, не тронувшие ни одного вопроса (last_block_id IS NULL).
func (Repo) CountByLastBlock(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period, f domain.VisitFilter) ([]domain.LastBlockCount, error) {
	from, to := postgres.PeriodBounds(period)
	kind, keys := segParams(f)
	rows, err := postgres.New(db).CountVisitsByLastBlock(ctx, postgres.CountVisitsByLastBlockParams{
		FormID:  formID,
		FromTs:  from,
		ToTs:    to,
		SegKind: kind,
		SegKeys: keys,
	})
	if err != nil {
		return nil, fmt.Errorf("count visits by last block: %w", err)
	}
	out := make([]domain.LastBlockCount, len(rows))
	for i, r := range rows {
		out[i] = domain.LastBlockCount{
			BlockID:   r.LastBlockID.String, // невалидный (NULL) даёт "" — верх воронки
			Submitted: r.Submitted,
			Visits:    int(r.Visits),
		}
	}
	return out, nil
}

// Insights — счётчики визитов для карточек над вкладками Insights: сколько пришло,
// сколько отправило, медианная длительность и её знаменатель (сколько визитов в
// медиану вошло — экран обязан отличать «данных нет» от «ноль секунд»).
func (Repo) Insights(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period, f domain.VisitFilter) (domain.VisitInsights, error) {
	from, to := postgres.PeriodBounds(period)
	kind, keys := segParams(f)
	row, err := postgres.New(db).VisitInsights(ctx, postgres.VisitInsightsParams{
		FormID:  formID,
		FromTs:  from,
		ToTs:    to,
		SegKind: kind,
		SegKeys: keys,
	})
	if err != nil {
		return domain.VisitInsights{}, fmt.Errorf("visit insights: %w", err)
	}
	return domain.VisitInsights{
		Visits:                int(row.Visits),
		Submitted:             int(row.Submitted),
		UniqueVisitors:        int(row.UniqueVisitors),
		TimedVisits:           int(row.TimedVisits),
		MedianDurationSec:     row.MedianDurationSec,
		TimedCompletions:      int(row.TimedCompletions),
		CompletionDurationSec: row.CompletionDurationSec,
	}, nil
}

// Timeseries — ряд визитов по времени. Отдаются только непустые корзины: дыры
// достраивает домен, у которого есть границы периода.
func (Repo) Timeseries(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period, step domain.BucketStep) ([]domain.TimeBucket, error) {
	from, to := postgres.PeriodBounds(period)
	rows, err := postgres.New(db).VisitTimeseries(ctx, postgres.VisitTimeseriesParams{
		FormID: formID,
		Step:   string(step),
		FromTs: from,
		ToTs:   to,
	})
	if err != nil {
		return nil, fmt.Errorf("visit timeseries: %w", err)
	}
	out := make([]domain.TimeBucket, len(rows))
	for i, r := range rows {
		out[i] = domain.TimeBucket{
			At:        r.Bucket.Time,
			Visits:    int(r.Visits),
			Submitted: int(r.Submitted),
		}
	}
	return out, nil
}

// Sources — сгруппированные метки происхождения. Что из них считать источником,
// решает домен: здесь только тройки и счётчики.
func (Repo) Sources(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) ([]domain.SourceRow, error) {
	from, to := postgres.PeriodBounds(period)
	rows, err := postgres.New(db).VisitSources(ctx, postgres.VisitSourcesParams{
		FormID: formID,
		FromTs: from,
		ToTs:   to,
	})
	if err != nil {
		return nil, fmt.Errorf("visit sources: %w", err)
	}
	out := make([]domain.SourceRow, len(rows))
	for i, r := range rows {
		out[i] = domain.SourceRow{
			Referer:   r.Referer,
			UTMSource: r.UtmSource,
			UTMMedium: r.UtmMedium,
			Visits:    int(r.Visits),
			Submitted: int(r.Submitted),
		}
	}
	return out, nil
}

// UserAgents — сгруппированные строки user-agent. Разбор — в домене.
func (Repo) UserAgents(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) ([]domain.UserAgentRow, error) {
	from, to := postgres.PeriodBounds(period)
	rows, err := postgres.New(db).VisitUserAgents(ctx, postgres.VisitUserAgentsParams{
		FormID: formID,
		FromTs: from,
		ToTs:   to,
	})
	if err != nil {
		return nil, fmt.Errorf("visit user agents: %w", err)
	}
	out := make([]domain.UserAgentRow, len(rows))
	for i, r := range rows {
		out[i] = domain.UserAgentRow{UserAgent: r.UserAgent, Visits: int(r.Visits), Submitted: int(r.Submitted)}
	}
	return out, nil
}

// Countries — визиты по странам за период. Визиты без гео сюда не попадают.
func (Repo) Countries(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) ([]domain.PlaceCount, error) {
	from, to := postgres.PeriodBounds(period)
	rows, err := postgres.New(db).VisitCountries(ctx, postgres.VisitCountriesParams{
		FormID: formID,
		FromTs: from,
		ToTs:   to,
	})
	if err != nil {
		return nil, fmt.Errorf("visit countries: %w", err)
	}
	out := make([]domain.PlaceCount, len(rows))
	for i, r := range rows {
		out[i] = domain.PlaceCount{
			Name:        r.Country,
			CountryCode: r.CountryCode.String,
			Visits:      int(r.Visits),
			Submitted:   int(r.Submitted),
		}
	}
	return out, nil
}

// Cities — визиты по городам за период. Код страны едет рядом: одноимённые города в
// разных странах склеивать нельзя.
func (Repo) Cities(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) ([]domain.PlaceCount, error) {
	from, to := postgres.PeriodBounds(period)
	rows, err := postgres.New(db).VisitCities(ctx, postgres.VisitCitiesParams{
		FormID: formID,
		FromTs: from,
		ToTs:   to,
	})
	if err != nil {
		return nil, fmt.Errorf("visit cities: %w", err)
	}
	out := make([]domain.PlaceCount, len(rows))
	for i, r := range rows {
		out[i] = domain.PlaceCount{
			Name:        r.City.String,
			CountryCode: r.CountryCode.String,
			Visits:      int(r.Visits),
			Submitted:   int(r.Submitted),
		}
	}
	return out, nil
}
