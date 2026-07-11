package periodic

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// waitFor блокирует до сигнала на ch либо валит тест по таймауту.
func waitFor(t *testing.T, ch <-chan struct{}, msg string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal(msg)
	}
}

func TestRunner_TicksThenStops(t *testing.T) {
	ran := make(chan struct{}, 8)
	r := NewRunner(discardLogger())
	ctx, cancel := context.WithCancel(context.Background())

	r.Start(ctx, Task{Name: "tick", Interval: time.Millisecond, Run: func(context.Context) error {
		select {
		case ran <- struct{}{}:
		default:
		}
		return nil
	}})

	waitFor(t, ran, "задача не выполнилась за 2 с")

	cancel()
	done := make(chan struct{})
	go func() { r.Wait(); close(done) }()
	waitFor(t, done, "Wait не вернулся после отмены контекста")
}

func TestRunner_ErrorDoesNotStopLoop(t *testing.T) {
	ran := make(chan struct{}, 8)
	r := NewRunner(discardLogger())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	r.Start(ctx, Task{Name: "boom", Interval: time.Millisecond, Run: func(context.Context) error {
		select {
		case ran <- struct{}{}:
		default:
		}
		return errors.New("всегда падает")
	}})

	// Падающая задача не должна ронять цикл: она обязана прогнаться повторно.
	waitFor(t, ran, "первый прогон не случился")
	waitFor(t, ran, "цикл остановился после ошибки — второго прогона нет")
}
