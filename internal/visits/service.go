package visits

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/forms"
	"github.com/ka-shmd/trierra/internal/postgres"
)

// maxMetaFieldLen — потолок длины строк меты (user_agent, referer, значения utm):
// обрезаем, чтобы раздутый заголовок не распухал JSONB. Совпадает по значению с
// submissions, но свой — модули не делят константы.
const maxMetaFieldLen = 512

// utmKeys — что считаем меткой источника. Список закрытый, а не «всё, что начинается
// на utm_»: иначе публичная ручка на запись превращается в приём произвольного
// словаря от клиента (раздувание JSONB, мусор в аналитике).
var utmKeys = [...]string{"utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"}

// Forms — коллаборатор из модуля forms: отдаёт опубликованную форму по slug.
// Реализация — *forms.Service; общение через интерфейс сервиса (не чужой repo).
type Forms interface {
	PublicForm(ctx context.Context, slug string) (forms.PublicForm, error)
}

// Store — доступ к данным visits, объявленный на стороне потребителя.
type Store interface {
	UpsertVisit(ctx context.Context, db postgres.DBTX, id, formID, versionID uuid.UUID, lastBlockID *string, seq int16, meta json.RawMessage) error
	MarkSubmitted(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error)
	CountVisits(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (Counts, error)
}

var _ Store = Repo{}

// Visit — то, что присылает бикон рендерера. Version — номер версии, которую
// РЕАЛЬНО открыл человек (не «текущая опубликованная»): без него визит переклеился
// бы на свежую версию после переиздания, и last_block_id искали бы в чужой схеме.
// LastBlockID nil — «открыл, но ни одного вопроса не коснулся».
type Visit struct {
	ID          uuid.UUID
	Version     int32
	LastBlockID *string
	Seq         int16
	UserAgent   string
	Referer     string
	UTM         map[string]string
}

// Service — запись визитов и чтение счётчиков.
type Service struct {
	db    postgres.DBTX
	forms Forms
	repo  Store
	now   func() time.Time // подменяется в тестах (проверка даты закрытия)
}

func NewService(db postgres.DBTX, forms Forms, repo Store) *Service {
	return &Service{db: db, forms: forms, repo: repo, now: time.Now}
}

// Record записывает визит. Порядок повторяет приём ответа: резолв формы (черновик/
// нет → 404, приватное не раскрывается) → «форма закрыта» → валидация → запись.
//
// Закрытая форма визит НЕ пишет (410). Рендерер до бикона и не дойдёт — GET закрытой
// отдаёт 410 и вместо формы рисуется «приём закрыт», — но ручка публичная, и
// принимать по ней то, чего не бывает в жизни, значит открывать способ портить
// владельцу конверсию визитами, которые ответом закончиться не могли.
func (s *Service) Record(ctx context.Context, slug string, v Visit) error {
	pf, err := s.forms.PublicForm(ctx, slug)
	if err != nil {
		return err
	}
	if domain.FormClosed(pf.Status, pf.CloseAt, pf.ResponseLimit, pf.SubmissionCount, s.now().UTC()) {
		return domain.ErrFormClosed
	}

	// Версия из бикона обязана совпасть с опубликованной сейчас. Расхождение = форму
	// переиздали между открытием страницы и биконом; окно микроскопическое (бикон
	// «открыли» уходит через миллисекунды после GET), и терять такой визит честнее,
	// чем приписать его версии, которой человек не видел. Ищем именно ЭТУ ошибку, а
	// не «версия не найдена»: form_version_id берём из pf, второй запрос не нужен.
	if v.Version != pf.Version {
		return fmt.Errorf("%w: форма переиздана", domain.ErrValidation)
	}

	if v.Seq < 0 {
		return fmt.Errorf("%w: неверный seq", domain.ErrValidation)
	}
	if v.LastBlockID != nil {
		id := *v.LastBlockID
		if id == "" || len(id) > domain.MaxIDLen || !utf8.ValidString(id) {
			return fmt.Errorf("%w: неверный last_block_id", domain.ErrValidation)
		}
	}

	// Существование блока в схеме НЕ проверяем: чужой id не портит данные — воронка
	// читает подписи из схемы версии и просто не найдёт его, а лишний разбор JSONB
	// схемы на каждом биконе оплачивался бы на самом частом публичном запросе.

	metaJSON, err := json.Marshal(s.buildMeta(v))
	if err != nil {
		return fmt.Errorf("marshal visit meta: %w", err)
	}
	return s.repo.UpsertVisit(ctx, s.db, v.ID, pf.FormID, pf.VersionID, v.LastBlockID, v.Seq, metaJSON)
}

func (s *Service) buildMeta(v Visit) map[string]string {
	meta := map[string]string{
		"user_agent": truncate(v.UserAgent, maxMetaFieldLen),
		"referer":    truncate(v.Referer, maxMetaFieldLen),
	}
	for _, k := range utmKeys {
		if val := truncate(v.UTM[k], maxMetaFieldLen); val != "" {
			meta[k] = val
		}
	}
	return meta
}

// MarkSubmitted отмечает визит как закончившийся ответом. Вызывается приёмом ответа
// ПОСЛЕ его коммита и best-effort: неизвестный или подделанный visitId даёт 0 строк
// и не является ошибкой — аналитика не имеет права отклонить принятый ответ.
func (s *Service) MarkSubmitted(ctx context.Context, formID, visitID uuid.UUID) error {
	_, err := s.repo.MarkSubmitted(ctx, s.db, visitID, formID)
	return err
}

// Counts — просмотры и конверсия формы. Авторизацию доступа к форме делает
// вызывающий (модуль forms знает про членство в воркспейсе).
func (s *Service) Counts(ctx context.Context, formID uuid.UUID) (Counts, error) {
	return s.repo.CountVisits(ctx, s.db, formID)
}

// truncate режет строку по границе рун: обрезка по байтам оставила бы хвост битой
// руны, и JSONB получил бы невалидный UTF-8.
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}
