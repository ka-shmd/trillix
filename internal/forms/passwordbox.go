package forms

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
)

// Пароль формы лежит в БД ОБРАТИМО — шифротекстом, а не хешем (решение владельца
// 2026-09-01, docs/design/form-password.md §2.1). Автор видит и копирует свой пароль,
// потому что это не учётная запись, а общий секрет, который он рассылает участникам:
// «забыл пароль формы» означает «покажите, что я разослал», а не сброс доступа.
//
// Инвариант безопасности 2 («пароли — только argon2id-хеш») говорит о паролях
// АККАУНТОВ, и пароль формы под него не подпадает: за ним нет ни личности, ни сессии,
// ни права в кабинете. Строка здесь потому, что при беглом чтении инварианта это
// выглядит нарушением.
//
// Ключ выводится HKDF из секрета токена формы с отдельной меткой назначения — тот же
// приём и тот же довод, что у refresh-токенов
// интеграций (internal/integrations/secretbox.go): ещё одна env-переменная в трёх
// контурах, в CI и в раннбуке стоит дороже, чем даёт.
//
// Плата названа вслух: ротация FORM_TOKEN_SECRET рвёт пароли ВСЕХ форм (расшифровать
// нечем, автор ставит новый) — это идёт в раннбук ротации рядом с тем же следствием
// для второго фактора и подключений интеграций.
const passwordLabel = "trillix-form-password-v1"

// errNoSecret — сервису не передали секрет (WithSecret). Отказ, а не работа без
// шифрования: пароль, сохранённый открытым текстом, хуже отсутствующего.
var errNoSecret = errors.New("forms: password secret not configured")

// sealPassword шифрует пароль формы для хранения в колонке forms.password.
func sealPassword(key []byte, plain string) ([]byte, error) {
	gcm, err := passwordGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("forms: random nonce: %w", err)
	}
	// Nonce едет впереди шифротекста: он не секрет, но обязан быть уникальным.
	return gcm.Seal(nonce, nonce, []byte(plain), nil), nil
}

// openPassword расшифровывает пароль формы.
func openPassword(key, sealed []byte) (string, error) {
	gcm, err := passwordGCM(key)
	if err != nil {
		return "", err
	}
	if len(sealed) < gcm.NonceSize() {
		return "", fmt.Errorf("forms: sealed password too short")
	}
	nonce, ct := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", fmt.Errorf("forms: open password: %w", err)
	}
	return string(plain), nil
}

func passwordGCM(key []byte) (cipher.AEAD, error) {
	if len(key) == 0 {
		return nil, errNoSecret
	}
	derived, err := hkdf.Key(sha256.New, key, nil, passwordLabel, 32)
	if err != nil {
		return nil, fmt.Errorf("forms: derive password key: %w", err)
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return nil, fmt.Errorf("forms: cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("forms: gcm: %w", err)
	}
	return gcm, nil
}
