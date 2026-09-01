package ai

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
)

// Fake — генератор для тестов: отдаёт заготовленные ответы по порядку и
// записывает, что у него спросили. Живёт в обычном файле, а не в _test.go,
// потому что нужен тестам ДРУГИХ пакетов (тот же приём, что у
// ratelimit.AllowAll).
//
// Записанные запросы — не удобство, а сторож инварианта «ответы респондентов в
// модель не уезжают»: тест правки формы читает Requests и убеждается, что
// содержимого ответов там нет.
type Fake struct {
	mu       sync.Mutex
	replies  []FakeReply
	requests []Request
}

// FakeReply — один заготовленный исход вызова: либо ответ, либо отказ.
type FakeReply struct {
	Answer json.RawMessage
	Err    error
}

// NewFake — Fake, отдающий эти ответы по одному на вызов.
func NewFake(answers ...string) *Fake {
	replies := make([]FakeReply, 0, len(answers))
	for _, a := range answers {
		replies = append(replies, FakeReply{Answer: json.RawMessage(a)})
	}
	return &Fake{replies: replies}
}

// NewFakeReplies — Fake со смешанной очередью (ответ, отказ, ответ): так
// проверяется цикл починки у потребителя.
func NewFakeReplies(replies ...FakeReply) *Fake {
	return &Fake{replies: append([]FakeReply(nil), replies...)}
}

// errFakeDrained — вызовов оказалось больше, чем заготовлено ответов. Отдельная
// ошибка, а не повтор последнего: молчаливый повтор скрыл бы лишний вызов
// модели, то есть лишние деньги, — а именно это тест и должен ловить.
var errFakeDrained = errors.New("ai: у Fake кончились заготовленные ответы")

func (f *Fake) Generate(_ context.Context, req Request) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, req)
	if len(f.replies) == 0 {
		return nil, errFakeDrained
	}
	reply := f.replies[0]
	f.replies = f.replies[1:]
	if reply.Err != nil {
		return nil, reply.Err
	}
	return reply.Answer, nil
}

// Requests — копия записанных вызовов в порядке их поступления.
func (f *Fake) Requests() []Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Request(nil), f.requests...)
}

var _ Generator = (*Fake)(nil)
