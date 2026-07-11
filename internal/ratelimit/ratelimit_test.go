package ratelimit

import (
	"testing"
	"time"
)

func TestTokenBucket_BurstThenDeny(t *testing.T) {
	now := time.Now()
	b := NewTokenBucket(1, 3) // 3 токена в запасе, пополнение 1/сек
	b.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if !b.Allow("ip") {
			t.Fatalf("запрос %d должен пройти в пределах burst", i+1)
		}
	}
	if b.Allow("ip") {
		t.Fatal("четвёртый запрос должен быть отклонён — ведро пусто")
	}
}

func TestTokenBucket_RefillsOverTime(t *testing.T) {
	now := time.Now()
	b := NewTokenBucket(1, 1) // 1 токен, пополнение 1/сек
	b.now = func() time.Time { return now }

	if !b.Allow("ip") {
		t.Fatal("первый запрос должен пройти")
	}
	if b.Allow("ip") {
		t.Fatal("второй запрос сразу — отклонён")
	}

	now = now.Add(time.Second) // прошла секунда → +1 токен
	if !b.Allow("ip") {
		t.Fatal("после паузы запрос должен снова пройти")
	}
}

func TestTokenBucket_PerKeyIsolation(t *testing.T) {
	now := time.Now()
	b := NewTokenBucket(1, 1)
	b.now = func() time.Time { return now }

	if !b.Allow("a") {
		t.Fatal("ключ a: первый запрос должен пройти")
	}
	if !b.Allow("b") {
		t.Fatal("ключ b не должен зависеть от ключа a")
	}
}

func TestAllowAll(t *testing.T) {
	var a AllowAll
	for i := 0; i < 1000; i++ {
		if !a.Allow("any") {
			t.Fatal("AllowAll обязан всегда разрешать")
		}
	}
}
