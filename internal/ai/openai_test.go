package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const testKey = "секретный-ключ-провайдера"

func testClient(t *testing.T, h http.HandlerFunc) (*Client, *bytes.Buffer) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	logs := &bytes.Buffer{}
	log := slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return NewClient(Options{
		BaseURL:    srv.URL,
		APIKey:     testKey,
		Model:      "gpt://каталог/модель/latest",
		HTTPClient: srv.Client(),
		Log:        log,
	}), logs
}

func answer(content string) string {
	body, _ := json.Marshal(map[string]any{
		"choices": []any{map[string]any{
			"finish_reason": "stop",
			"message":       map[string]any{"role": "assistant", "content": content},
		}},
		"usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
	})
	return string(body)
}

func TestGenerate(t *testing.T) {
	t.Run("запрос собран по-openai'ному, ответ отдан сырым", func(t *testing.T) {
		var got chatRequest
		var auth, project, ctype string
		client, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
			auth, project, ctype = r.Header.Get("Authorization"), r.Header.Get("OpenAI-Project"), r.Header.Get("Content-Type")
			if r.URL.Path != "/chat/completions" {
				t.Errorf("путь = %q, ожидался /chat/completions", r.URL.Path)
			}
			raw, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatalf("тело запроса не разобралось: %v", err)
			}
			_, _ = io.WriteString(w, answer(`{"questions":[]}`))
		})

		out, err := client.Generate(context.Background(), Request{
			System:     "собери план формы",
			User:       "анкета записи в барбершоп",
			SchemaName: "form_plan",
			Schema:     json.RawMessage(`{"type":"object"}`),
			MaxTokens:  4000,
		})
		if err != nil {
			t.Fatalf("Generate() вернул ошибку: %v", err)
		}
		if string(out) != `{"questions":[]}` {
			t.Errorf("ответ = %s, ожидался сырой JSON модели", out)
		}
		if auth != "Bearer "+testKey {
			t.Errorf("Authorization = %q, ожидался Bearer с ключом", auth)
		}
		if ctype != "application/json" {
			t.Errorf("Content-Type = %q", ctype)
		}
		// Проект не задан — заголовка быть не должно: Яндексу он не нужен.
		if project != "" {
			t.Errorf("OpenAI-Project = %q, ожидалось отсутствие заголовка", project)
		}
		if got.Model != "gpt://каталог/модель/latest" || got.MaxTokens != 4000 {
			t.Errorf("model/max_tokens = %q/%d", got.Model, got.MaxTokens)
		}
		if len(got.Messages) != 2 || got.Messages[0].Role != "system" || got.Messages[1].Role != "user" {
			t.Fatalf("messages = %+v, ожидались system и user", got.Messages)
		}
		if got.ResponseFormat == nil || got.ResponseFormat.Type != "json_schema" {
			t.Fatalf("response_format = %+v, ожидался json_schema", got.ResponseFormat)
		}
		if !got.ResponseFormat.JSONSchema.Strict || got.ResponseFormat.JSONSchema.Name != "form_plan" {
			t.Errorf("json_schema = %+v, ожидались strict и имя схемы", got.ResponseFormat.JSONSchema)
		}
	})

	// Умолчание рассуждающей модели — «думать», и это решает судьбу операции:
	// с размышлениями сборка формы идёт в разы дольше при том же результате.
	// Поле едет только заданным: вход, не знающий его, отвечает 400.
	t.Run("усилие рассуждения едет только заданным", func(t *testing.T) {
		var withEffort, withoutEffort map[string]any
		client, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &withoutEffort)
			_, _ = io.WriteString(w, answer(`{"ok":true}`))
		})
		if _, err := client.Generate(context.Background(), Request{User: "анкета"}); err != nil {
			t.Fatalf("Generate() вернул ошибку: %v", err)
		}
		if _, ok := withoutEffort["reasoning_effort"]; ok {
			t.Error("поле уехало, хотя усилие не задано — вход без его поддержки ответит 400")
		}

		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &withEffort)
			_, _ = io.WriteString(w, answer(`{"ok":true}`))
		}))
		defer srv.Close()
		tuned := NewClient(Options{
			BaseURL: srv.URL, APIKey: testKey, Model: "модель",
			ReasoningEffort: "none", HTTPClient: srv.Client(),
		})
		if _, err := tuned.Generate(context.Background(), Request{User: "анкета"}); err != nil {
			t.Fatalf("Generate() вернул ошибку: %v", err)
		}
		if withEffort["reasoning_effort"] != "none" {
			t.Errorf("reasoning_effort = %v, ожидалось none", withEffort["reasoning_effort"])
		}
	})

	t.Run("без схемы просим произвольный JSON", func(t *testing.T) {
		var got chatRequest
		client, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &got)
			_, _ = io.WriteString(w, answer(`{"ok":true}`))
		})
		if _, err := client.Generate(context.Background(), Request{User: "что-нибудь"}); err != nil {
			t.Fatalf("Generate() вернул ошибку: %v", err)
		}
		if got.ResponseFormat == nil || got.ResponseFormat.Type != "json_object" {
			t.Errorf("response_format = %+v, ожидался json_object", got.ResponseFormat)
		}
		if len(got.Messages) != 1 {
			t.Errorf("messages = %+v, ожидался только user", got.Messages)
		}
	})

	// Рассуждающая модель съедает потолок токенов рассуждением и отдаёт content:
	// null. Это ретраится, а не разбирается как пустой документ.
	t.Run("пустой ответ ретраится один раз", func(t *testing.T) {
		var calls atomic.Int32
		client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
			n := calls.Add(1)
			if n == 1 {
				_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"length","message":{"role":"assistant","content":null}}],"usage":{"completion_tokens":50}}`)
				return
			}
			_, _ = io.WriteString(w, answer(`{"questions":[{"type":"email"}]}`))
		})

		out, err := client.Generate(context.Background(), Request{User: "анкета"})
		if err != nil {
			t.Fatalf("Generate() вернул ошибку: %v", err)
		}
		if !strings.Contains(string(out), "email") {
			t.Errorf("ответ = %s, ожидался ответ второй попытки", out)
		}
		if calls.Load() != 2 {
			t.Errorf("вызовов провайдера = %d, ожидалось 2", calls.Load())
		}
	})

	t.Run("пустой ответ дважды — ErrEmptyAnswer", func(t *testing.T) {
		var calls atomic.Int32
		client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
			calls.Add(1)
			_, _ = io.WriteString(w, `{"choices":[{"finish_reason":"length","message":{"content":null}}]}`)
		})

		_, err := client.Generate(context.Background(), Request{User: "анкета"})
		if !errors.Is(err, ErrEmptyAnswer) {
			t.Fatalf("ошибка = %v, ожидалась ErrEmptyAnswer", err)
		}
		if calls.Load() != 2 {
			t.Errorf("вызовов провайдера = %d, ожидалось 2 (ретрай ровно один)", calls.Load())
		}
	})

	// Обрыв по потолку: текст ЕСТЬ, и на вид он обычный ответ. Отличить его можно
	// только по finish_reason, и без этого обрубок JSON уезжал потребителю как
	// годный ответ (замер 2026-09-02 — 503 автору вместо формы).
	truncated := `{"choices":[{"finish_reason":"length","message":{"content":"{\"action\":\"edit\",\"add\":[{\"after\":\"\",\"it"}}],` +
		`"usage":{"completion_tokens":4000}}`

	// Вырождение недетерминированное (около 17% попыток по замеру), поэтому повтор —
	// рабочее лекарство, а не надежда: до автора доходит ~3% отказов вместо 17%.
	t.Run("оборванный ответ ретраится один раз", func(t *testing.T) {
		var calls atomic.Int32
		client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
			if calls.Add(1) == 1 {
				_, _ = io.WriteString(w, truncated)
				return
			}
			_, _ = io.WriteString(w, answer(`{"questions":[{"type":"email"}]}`))
		})

		out, err := client.Generate(context.Background(), Request{User: "собери форму записи на маникюр"})
		if err != nil {
			t.Fatalf("Generate() вернул ошибку: %v", err)
		}
		if !strings.Contains(string(out), "email") {
			t.Errorf("ответ = %s, ожидался ответ второй попытки", out)
		}
	})

	// Попыток у обрыва на одну больше, чем у остальных отказов: вырождение — бросок
	// монеты на каждой попытке, а не состояние провайдера.
	t.Run("оборванный ответ трижды — ErrTruncated", func(t *testing.T) {
		var calls atomic.Int32
		client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
			calls.Add(1)
			_, _ = io.WriteString(w, truncated)
		})

		_, err := client.Generate(context.Background(), Request{User: "собери форму записи на маникюр"})
		if !errors.Is(err, ErrTruncated) {
			t.Fatalf("ошибка = %v, ожидалась ErrTruncated", err)
		}
		if calls.Load() != 3 {
			t.Errorf("вызовов провайдера = %d, ожидалось 3", calls.Load())
		}
	})

	// А у отказа провайдера — по-прежнему две: третья попытка достучаться до
	// молчащего входа это только ожидание автора.
	t.Run("обрыв не поднимает лимит попыток другим отказам", func(t *testing.T) {
		var calls atomic.Int32
		client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
			calls.Add(1)
			w.WriteHeader(http.StatusBadGateway)
		})

		if _, err := client.Generate(context.Background(), Request{User: "анкета"}); !errors.Is(err, ErrProvider) {
			t.Fatalf("ошибка = %v, ожидалась ErrProvider", err)
		}
		if calls.Load() != 2 {
			t.Errorf("вызовов провайдера = %d, ожидалось 2", calls.Load())
		}
	})

	t.Run("5xx ретраится, 4xx нет", func(t *testing.T) {
		for _, tc := range []struct {
			name      string
			status    int
			wantCalls int32
		}{
			{"провайдер прилёг", http.StatusBadGateway, 2},
			{"наш запрос не понравился", http.StatusBadRequest, 1},
			{"ключ не подошёл", http.StatusUnauthorized, 1},
		} {
			t.Run(tc.name, func(t *testing.T) {
				var calls atomic.Int32
				client, _ := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
					calls.Add(1)
					w.WriteHeader(tc.status)
					_, _ = io.WriteString(w, `{"error":{"message":"нет"}}`)
				})

				_, err := client.Generate(context.Background(), Request{User: "анкета"})
				if !errors.Is(err, ErrProvider) {
					t.Fatalf("ошибка = %v, ожидалась ErrProvider", err)
				}
				if calls.Load() != tc.wantCalls {
					t.Errorf("вызовов провайдера = %d, ожидалось %d", calls.Load(), tc.wantCalls)
				}
			})
		}
	})

	// Инвариант 2/7: ключ провайдера не попадает в логи ни на удаче, ни на отказе.
	t.Run("ключ не попадает в лог", func(t *testing.T) {
		client, logs := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `{"error":{"message":"внутренняя ошибка"}}`)
		})
		_, _ = client.Generate(context.Background(), Request{User: "анкета"})

		client2, logs2 := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, answer(`{"ok":true}`))
		})
		_, _ = client2.Generate(context.Background(), Request{User: "анкета"})

		for name, buf := range map[string]*bytes.Buffer{"отказ": logs, "удача": logs2} {
			if strings.Contains(buf.String(), testKey) {
				t.Errorf("лог (%s) содержит ключ провайдера", name)
			}
		}
	})

	t.Run("контур без провайдера отвечает ErrDisabled", func(t *testing.T) {
		client := NewClient(Options{Model: "модель"})
		if _, err := client.Generate(context.Background(), Request{User: "анкета"}); !errors.Is(err, ErrDisabled) {
			t.Fatalf("ошибка = %v, ожидалась ErrDisabled", err)
		}
		if _, err := (Disabled{}).Generate(context.Background(), Request{}); !errors.Is(err, ErrDisabled) {
			t.Fatalf("Disabled вернул %v, ожидалась ErrDisabled", err)
		}
	})
}

func TestFake(t *testing.T) {
	fake := NewFakeReplies(
		FakeReply{Err: ErrEmptyAnswer},
		FakeReply{Answer: json.RawMessage(`{"questions":[]}`)},
	)

	if _, err := fake.Generate(context.Background(), Request{User: "первый"}); !errors.Is(err, ErrEmptyAnswer) {
		t.Fatalf("первый вызов = %v, ожидалась заготовленная ошибка", err)
	}
	out, err := fake.Generate(context.Background(), Request{User: "второй"})
	if err != nil || string(out) != `{"questions":[]}` {
		t.Fatalf("второй вызов = %s, %v", out, err)
	}
	if _, err := fake.Generate(context.Background(), Request{User: "третий"}); !errors.Is(err, errFakeDrained) {
		t.Fatalf("третий вызов = %v, ожидалось «ответы кончились»", err)
	}

	reqs := fake.Requests()
	if len(reqs) != 3 || reqs[0].User != "первый" || reqs[2].User != "третий" {
		t.Fatalf("записанные запросы = %+v", reqs)
	}
}
