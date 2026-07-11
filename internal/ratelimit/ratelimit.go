package ratelimit

import (
	"sync"
	"time"
)

// TokenBucket — потокобезопасный лимитер по ключу (обычно IP): у каждого ключа
// своё ведро на burst токенов, пополняемое rate токенов в секунду. Реализация
// на map + Mutex, без внешних зависимостей.
type TokenBucket struct {
	mu     sync.Mutex
	rate   float64 // токенов в секунду
	burst  float64 // максимум токенов (и стартовый запас)
	now    func() time.Time
	states map[string]*bucketState
}

type bucketState struct {
	tokens float64
	last   time.Time
}

// NewTokenBucket создаёт лимитер: rate токенов/сек, ведро глубиной burst.
func NewTokenBucket(rate, burst float64) *TokenBucket {
	return &TokenBucket{
		rate:   rate,
		burst:  burst,
		now:    time.Now,
		states: make(map[string]*bucketState),
	}
}

// Allow списывает токен для key и сообщает, разрешён ли запрос.
func (b *TokenBucket) Allow(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := b.now()
	st, ok := b.states[key]
	if !ok {
		b.states[key] = &bucketState{tokens: b.burst - 1, last: now}
		return true
	}

	elapsed := now.Sub(st.last).Seconds()
	st.tokens = min(b.burst, st.tokens+elapsed*b.rate)
	st.last = now

	if st.tokens < 1 {
		return false
	}
	st.tokens--
	return true
}

// AllowAll — пермиссивный лимитер для тестов (инвариант безопасности 6:
// лимитер не ослабляется в проде, а в тестах инжектируется этой реализацией).
type AllowAll struct{}

func (AllowAll) Allow(string) bool { return true }
