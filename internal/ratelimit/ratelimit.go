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

// GC удаляет дополна пополнившиеся (простаивающие) ведра и возвращает их число.
// Безопасно: полное ведро неотличимо от отсутствующего ключа (первый Allow по
// новому ключу даёт burst-1 и пропускает — ровно то же, что полное ведро при
// следующем запросе), поэтому удаление полного ведра лимит не меняет. Неполные
// ведра НЕ трогаем: их пересоздание вернуло бы клиенту полный запас — ослабление
// лимита (инвариант безопасности 6). Держит Mutex на время обхода карты: при
// большой карте кратко блокирует Allow, но GC запускается редко (см. вызов в
// cmd/api) — для одного VPS приемлемо.
func (b *TokenBucket) GC() int {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := b.now()
	removed := 0
	for key, st := range b.states {
		refilled := min(b.burst, st.tokens+now.Sub(st.last).Seconds()*b.rate)
		if refilled >= b.burst {
			delete(b.states, key)
			removed++
		}
	}
	return removed
}

// AllowAll — пермиссивный лимитер для тестов (инвариант безопасности 6:
// лимитер не ослабляется в проде, а в тестах инжектируется этой реализацией).
type AllowAll struct{}

func (AllowAll) Allow(string) bool { return true }
