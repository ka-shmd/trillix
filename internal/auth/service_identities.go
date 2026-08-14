package auth

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Способы входа через провайдеров на экране настроек (фаза 23 DEV-PLAN, слайс E).
// Вход через провайдера живёт в service_oauth.go; здесь — управление привязками
// из кабинета, где человек уже вошёл.

// Identities — способы входа текущего аккаунта.
func (s *Service) Identities(ctx context.Context, userID uuid.UUID) ([]Identity, error) {
	return s.repo.ListIdentities(ctx, s.db, userID)
}

// LinkIdentity привязывает личность у провайдера к УЖЕ вошедшему аккаунту
// (кнопка «Подключить» в настройках). Пароль здесь не спрашивается и не нужен:
// доказательством служит живая сессия, а тем, что личность принадлежит именно
// этому человеку, распорядился провайдер минуту назад.
//
// Отличие от LinkIdentityWithPassword — в том, кто кого догоняет: там человек
// пришёл ОТ провайдера и доказывает права на существующий аккаунт паролем,
// здесь он сидит В аккаунте и добавляет себе способ входа.
func (s *Service) LinkIdentity(ctx context.Context, userID uuid.UUID, p IdentityProfile) error {
	if err := s.repo.CreateIdentity(ctx, s.db, p.Provider, p.ProviderUserID, userID, normalizeEmail(p.Email)); err != nil {
		// Личность уже привязана — к этому же аккаунту (повторный клик) или к
		// чужому. Различать эти два случая в ответе нельзя: «привязана к другому»
		// рассказывает спрашивающему о чужом аккаунте.
		if isUniqueViolation(err) {
			return fmt.Errorf("%w: этот аккаунт провайдера уже привязан", domain.ErrConflict)
		}
		return err
	}
	return nil
}

// UnlinkIdentity отвязывает провайдера, но только если у человека останется чем
// войти. Проверка предусмотрена ещё миграцией 0009 — под неё там заведён индекс
// idx_user_identities_user.
//
// Отвязка отсутствующей привязки — не ошибка: DELETE идемпотентен, а повторный
// клик по кнопке не авария.
func (s *Service) UnlinkIdentity(ctx context.Context, user User, provider string) error {
	n, err := s.repo.CountIdentities(ctx, s.db, user.ID)
	if err != nil {
		return err
	}
	// Пароля нет и это последняя личность → после отвязки в аккаунт не войти
	// никак, а данные останутся внутри. Единственный правильный ответ — отказ с
	// внятным текстом, а не «мы предупреждали».
	if user.PasswordHash == nil && n <= 1 {
		return fmt.Errorf("%w: это единственный способ войти — сначала задайте пароль", domain.ErrConflict)
	}
	if _, err := s.repo.DeleteIdentity(ctx, s.db, user.ID, provider); err != nil {
		return err
	}
	return nil
}
