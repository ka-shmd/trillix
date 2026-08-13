package auth

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Настройки аккаунта (фаза 23 DEV-PLAN). Живут в модуле auth, а не в отдельном
// модуле: users пишет один модуль, два репо над одной таблицей нарушают
// направление зависимостей (internal/CLAUDE.md). Замысел и отвергнутые
// альтернативы — docs/design/account-settings.md.

// MaxPersonNameLen — потолок имени и фамилии в РУНАХ (Zod на фронте считает
// кодовые единицы UTF-16 — расхождение общее для всех лимитов проекта, TD-48).
const MaxPersonNameLen = 100

// UpdateProfile ставит имя и фамилию текущего пользователя. Пустая строка —
// законное значение и означает «стереть»: в БД уезжает NULL.
func (s *Service) UpdateProfile(ctx context.Context, userID uuid.UUID, firstName, lastName string) (User, error) {
	first, err := normalizePersonName(firstName, "имя")
	if err != nil {
		return User{}, err
	}
	last, err := normalizePersonName(lastName, "фамилия")
	if err != nil {
		return User{}, err
	}
	return s.repo.UpdateProfile(ctx, s.db, userID, first, last)
}

// normalizePersonName приводит присланную строку к тому, что ложится в колонку:
// обрезает пробелы, проверяет длину, пустое отдаёт как nil. Пустая строка и NULL
// не должны быть двумя разными «не указано» — иначе первый же запрос, который
// сравнивает с одним из них, начнёт врать (та же причина в комментарии 0021).
func normalizePersonName(v, field string) (*string, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(v) > MaxPersonNameLen {
		return nil, fmt.Errorf("%w: %s длиннее %d символов", domain.ErrValidation, field, MaxPersonNameLen)
	}
	return &v, nil
}
