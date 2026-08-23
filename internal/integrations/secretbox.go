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
// довод, что у секрета TOTP (sealSecret в internal/auth/totp.go): ещё одна
// env-переменная в трёх контурах, в CI и в раннбуке стоит дороже, чем даёт.
//
// Плата названа вслух: ротация FORM_TOKEN_SECRET рвёт ВСЕ подключения (человек
// нажимает «Подключить» заново) — это идёт в раннбук ротации рядом с тем же
// следствием для второго фактора.
const secretLabel = "trillix-integration-refresh-v1"

func sealToken(key []byte, token string) ([]byte, error) {
	gcm, err := tokenGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("integrations: random nonce: %w", err)
	}
	// Nonce едет впереди шифротекста: он не секрет, но обязан быть уникальным.
	return gcm.Seal(nonce, nonce, []byte(token), nil), nil
}

func openToken(key, sealed []byte) (string, error) {
	gcm, err := tokenGCM(key)
	if err != nil {
		return "", err
	}
	if len(sealed) < gcm.NonceSize() {
		return "", fmt.Errorf("integrations: sealed token too short")
	}
	nonce, ct := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	token, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", fmt.Errorf("integrations: open token: %w", err)
	}
	return string(token), nil
}

func tokenGCM(key []byte) (cipher.AEAD, error) {
	derived, err := hkdf.Key(sha256.New, key, nil, secretLabel, 32)
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
