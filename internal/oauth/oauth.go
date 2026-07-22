// Package oauth — клиент входа через внешних провайдеров (authorization code
// + PKCE) на stdlib. Своя реализация вместо IdP или библиотеки — ADR §10
// docs/ARCHITECTURE.md.
//
// Пакет знает только про протокол: как собрать ссылку авторизации и как обменять
// код на профиль. Что делать с профилем (найти identity, завести пользователя,
// потребовать пароль при совпадении email) — дело internal/auth.
//
// Токен провайдера здесь же и умирает: он нужен ровно для одного запроса за
// профилем и наружу не возвращается — хранить чужие токены значит быть обязанным
// их шифровать, обновлять и отзывать ради возможностей, которых у продукта нет.
package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// Profile — всё, что мы узнаём о пришедшем человеке. Больше не запрашиваем:
// минимизация ПДн (152-ФЗ) и короткий экран согласия.
type Profile struct {
	// ID — идентификатор аккаунта у провайдера. Стабилен при смене email,
	// поэтому именно он, а не адрес, ложится в user_identities.
	ID string
	// Email — адрес из профиля. Провайдеры не сообщают, подтверждён ли он
	// (сверка 2026-07-22, DEV-PLAN фаза 11 шаг 1), поэтому доказательством
	// владения аккаунтом он не является и на нём не строится связывание.
	Email string
}

// Provider — один способ входа. Реализация на провайдера; реестр держит
// internal/auth. Интерфейс, а не конкретный тип, потому что второй провайдер
// (VK ID) записан пунктом очереди — BACKLOG.md.
type Provider interface {
	// Name — идентификатор в URL и в колонке user_identities.provider.
	Name() string
	// AuthURL — ссылка, на которую уводим браузер.
	AuthURL(state, verifier string) string
	// Exchange меняет код на профиль. Токен провайдера наружу не отдаётся.
	Exchange(ctx context.Context, code, verifier string) (Profile, error)
}

// ErrNoEmail — провайдер не отдал адрес (пользователь не дал согласия либо у
// аккаунта его нет). Отдельная ошибка, потому что это не сбой, а осмысленный
// исход, требующий человеческого текста на экране.
var ErrNoEmail = errors.New("oauth: провайдер не отдал email")

const (
	// 32 байта → 43 символа base64url. Для verifier это нижняя граница
	// RFC 7636 (43–128), для state — с запасом выше требований провайдеров.
	randomBytes = 32
	// Потолок на ответ провайдера: и токен, и профиль — это сотни байт.
	// Без него подконтрольный чужой хост может кормить нас гигабайтами.
	maxResponseBytes = 1 << 20
	// Провайдер в цепочке пользовательского запроса: без таймаута его
	// зависание держит наш handler и коннект к нему.
	requestTimeout = 10 * time.Second
)

// NewSecret отдаёт криптослучайную строку для state и code_verifier.
func NewSecret() (string, error) {
	b := make([]byte, randomBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("oauth: random: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Challenge — S256-преобразование verifier'а для PKCE. Метод plain не
// поддерживаем сознательно: он не даёт защиты, ради которой PKCE вводился.
func Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func newHTTPClient() *http.Client {
	return &http.Client{Timeout: requestTimeout}
}
