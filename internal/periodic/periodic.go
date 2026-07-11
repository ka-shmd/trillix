// Package periodic запускает именованные фоновые задачи на фиксированном
// интервале в том же процессе — без cron и без отдельного воркера
// (ARCHITECTURE §4.4). Единственный текущий потребитель — чистка истёкших
// сессий; механизм общий, чтобы будущие периодические задачи не плодили свои
// горутины и логи.
package periodic

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Task — периодическая задача. Run вызывается раз в Interval; её контекст —
// тот же, что у Runner, поэтому при остановке процесса выполняющийся прогон
// отменяется. Собственный дедлайн на прогон Run ставит сам.
type Task struct {
	Name     string
	Interval time.Duration
	Run      func(context.Context) error
}

// Runner владеет горутинами запущенных задач и даёт дождаться их корректной
// остановки (Wait) после отмены контекста.
type Runner struct {
	log *slog.Logger
	wg  sync.WaitGroup
}

func NewRunner(log *slog.Logger) *Runner {
	return &Runner{log: log}
}

// Start запускает t в отдельной горутине: первый прогон — через t.Interval,
// далее каждый интервал, пока ctx не отменён. Исход каждого прогона логируется.
func (r *Runner) Start(ctx context.Context, t Task) {
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		ticker := time.NewTicker(t.Interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.runOnce(ctx, t)
			}
		}
	}()
}

func (r *Runner) runOnce(ctx context.Context, t Task) {
	start := time.Now()
	if err := t.Run(ctx); err != nil {
		r.log.Error("periodic task failed",
			slog.String("task", t.Name),
			slog.String("error", err.Error()),
			slog.Duration("elapsed", time.Since(start)))
		return
	}
	r.log.Debug("periodic task ran",
		slog.String("task", t.Name),
		slog.Duration("elapsed", time.Since(start)))
}

// Wait блокирует до остановки всех запущенных задач. Вызывать после отмены
// контекста, переданного в Start.
func (r *Runner) Wait() {
	r.wg.Wait()
}
