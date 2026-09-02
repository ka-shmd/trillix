package httpserver

import (
	"log/slog"
	"net/http"
	"time"
)

// ExtendWriteDeadline продлевает дедлайн записи ЭТОГО соединения.
//
// Зачем это вообще нужно: у сервера один WriteTimeout на все ручки (server.go), и
// он короткий — это страховка от slowloris. Ручка, которая честно работает дольше,
// без продления рвёт соединение посреди ответа, и клиент видит не отказ, а обрыв
// (через прокси кабинета — 502 без единой строки в логе о причине). Первым на это
// наступил стриминг CSV (TD-4), вторым — печать PDF, третьим — сборка формы моделью.
//
// Провал продления НЕ отменяет запрос: обёртка writer'а может не уметь спускаться до
// соединения (Unwrap — middleware.go), и тогда единственное честное поведение —
// сказать об этом в лог и работать как раньше. Ошибку возвращать некому: вызывающий
// всё равно продолжит.
func ExtendWriteDeadline(w http.ResponseWriter, log *slog.Logger, d time.Duration) {
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(d)); err != nil {
		log.Warn("cannot extend write deadline",
			slog.String("error", err.Error()),
			slog.Duration("wanted", d))
	}
}
