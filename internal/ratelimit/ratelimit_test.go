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

func TestTokenBucket_GC_EvictsIdleFullBuckets(t *testing.T) {
	now := time.Now()
	b := NewTokenBucket(1, 3) // ведро на 3, пополнение 1/сек
	b.now = func() time.Time { return now }

	b.Allow("idle") // тратит 1 токен → 2 из 3

	// Свежее ведро (не пополнилось до burst) не эвиктится: иначе пересоздание
	// вернуло бы клиенту полный запас — ослабление лимита.
	if n := b.GC(); n != 0 {
		t.Fatalf("GC удалил %d неполных вёдер, ожидалось 0", n)
	}

	// Прошло достаточно, чтобы ведро пополнилось до burst (3 токена / 1 в сек).
	now = now.Add(3 * time.Second)
	if n := b.GC(); n != 1 {
		t.Fatalf("GC удалил %d вёдер, ожидалось 1 (полное)", n)
	}
}

func TestTokenBucket_GC_DoesNotWeakenLimit(t *testing.T) {
	now := time.Now()
	b := NewTokenBucket(1, 1) // 1 токен, пополнение 1/сек
	b.now = func() time.Time { return now }

	if !b.Allow("ip") {
		t.Fatal("первый запрос должен пройти")
	}
	// Ведро пусто (0 из 1) — неполное; GC не должен его удалить, иначе следующий
	// запрос получил бы свежий полный запас и обошёл лимит.
	if n := b.GC(); n != 0 {
		t.Fatalf("GC удалил %d вёдер, ожидалось 0 (ведро пусто, не полное)", n)
	}
	if b.Allow("ip") {
		t.Fatal("второй запрос сразу после GC должен быть отклонён — лимит не ослаблен")
	}
}

func TestTokenBucket_GC_ReAllowAfterEvict(t *testing.T) {
	now := time.Now()
	b := NewTokenBucket(1, 2)
	b.now = func() time.Time { return now }

	b.Allow("ip")
	now = now.Add(2 * time.Second) // пополнилось до burst
	if n := b.GC(); n != 1 {
		t.Fatalf("ожидался эвикт 1 полного ведра, удалено %d", n)
	}
	// После эвикта ключ ведёт себя как новый — Allow снова проходит.
	if !b.Allow("ip") {
		t.Fatal("после эвикта полного ведра запрос должен пройти")
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
