package integrations

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
)

// Refresh-токен провайдера — чужой секрет: он даёт доступ к Диску человека, пока
// тот не отзовёт согласие. В БД он лежит шифротекстом, ключ выводится HKDF из
// общего секрета приложения с отдельной меткой назначения — тот же приём и тот же
// довод, что у пароля формы (sealPassword в internal/forms/passwordbox.go): ещё одна
// env-переменная в трёх контурах, в CI и в раннбуке стоит дороже, чем даёт.
//
// Плата названа вслух: ротация FORM_TOKEN_SECRET рвёт ВСЕ подключения (человек
// нажимает «Подключить» заново) — это идёт в раннбук ротации рядом с тем же
// следствием для второго фактора.
const secretLabel = "trillix-integration-refresh-v1"

// webhookSecretLabel — метка ключа секретов подписи вебхуков (0062). Своя, а не
// общая с refresh-токенами: без разных меток шифротекст одного назначения
// открывался бы ключом другого. Ротация FORM_TOKEN_SECRET рвёт и эти секреты —
// вебхуки встают с причиной «перевыпустите секрет».
const webhookSecretLabel = "trillix-webhook-secret-v1"

func sealToken(key []byte, token string) ([]byte, error) { return seal(key, secretLabel, token) }

func openToken(key, sealed []byte) (string, error) { return openSealed(key, secretLabel, sealed) }

func sealWebhookSecret(key []byte, secret string) ([]byte, error) {
	return seal(key, webhookSecretLabel, secret)
}

func openWebhookSecret(key, sealed []byte) (string, error) {
	return openSealed(key, webhookSecretLabel, sealed)
}

func seal(key []byte, label, plaintext string) ([]byte, error) {
	gcm, err := gcmFor(key, label)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("integrations: random nonce: %w", err)
	}
	// Nonce едет впереди шифротекста: он не секрет, но обязан быть уникальным.
	return gcm.Seal(nonce, nonce, []byte(plaintext), nil), nil
}

func openSealed(key []byte, label string, sealed []byte) (string, error) {
	gcm, err := gcmFor(key, label)
	if err != nil {
		return "", err
	}
	if len(sealed) < gcm.NonceSize() {
		return "", fmt.Errorf("integrations: sealed value too short")
	}
	nonce, ct := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", fmt.Errorf("integrations: open sealed value: %w", err)
	}
	return string(plain), nil
}

func gcmFor(key []byte, label string) (cipher.AEAD, error) {
	derived, err := hkdf.Key(sha256.New, key, nil, label, 32)
	if err != nil {
		return nil, fmt.Errorf("integrations: derive key: %w", err)
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return nil, fmt.Errorf("integrations: cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("integrations: gcm: %w", err)
	}
	return gcm, nil
}
