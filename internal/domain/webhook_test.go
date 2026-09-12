package domain

import (
	"testing"
	"time"
)

// Эталон посчитан не нашим кодом, а так, как подпись проверит получатель:
//
//	printf '%s' '1757671200.{"version":1}' | openssl dgst -sha256 -hmac 'whsec_test'
//
// Совпадение с внешним инструментом — единственное доказательство, что формат
// подписи тот, что обещан в контракте, а не тот, что мы сами себе написали.
func TestSignWebhook_MatchesOpenSSL(t *testing.T) {
	got := SignWebhook("whsec_test", time.Unix(1757671200, 0), []byte(`{"version":1}`))
	want := "t=1757671200,v1=9b14bc7e022126e2247e5920b7fe96bf3fda6aade3b5eb1f3de3e44547ffce42"
	if got != want {
		t.Fatalf("подпись = %s,\nожидалось  %s", got, want)
	}
}

// Время входит в подпись: тот же запрос в другую секунду подписан иначе, и
// перехваченный запрос нельзя выдать за новый, переписав только t.
func TestSignWebhook_TimeIsSigned(t *testing.T) {
	body := []byte(`{"version":1}`)
	a := SignWebhook("whsec_test", time.Unix(1757671200, 0), body)
	b := SignWebhook("whsec_test", time.Unix(1757671201, 0), body)
	if a[len(a)-64:] == b[len(b)-64:] {
		t.Fatal("подпись не зависит от времени")
	}
}
