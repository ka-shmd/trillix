package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// Клиент говорит с ЛЮБЫМ входом, совместимым с OpenAI (ADR §10): сегодня это
// Яндекс AI Studio, дальше — свой сервер, и переезд означает другой AI_BASE_URL,
// а не другой код. Схема запроса поэтому взята openai'ная: /chat/completions,
// messages, response_format.
const (
	// Потолок тела ответа: план формы — единицы килобайт, мегабайт здесь означает
	// ошибку на той стороне.
	maxResponseBytes = 1 << 20
	// Провайдер стоит в цепочке пользовательского запроса (автор ждёт форму на
	// экране), поэтому таймаут обязателен. 30 с — с запасом на ответ (замер
	// 2026-09-01: 1,8–8 с на планах из трёх-пяти вопросов) и вдвое короче потолка
	// всей операции (forms.generateTimeout): зависший вызов обязан оставить время
	// повтору, иначе ретрай существует только на бумаге.
	requestTimeout = 30 * time.Second
	// dialTimeout — отдельно и коротко: наблюдаемый способ отказа этого провайдера
	// — не медленный ответ, а НЕустановленное соединение (замер 2026-09-01: часть
	// попыток не доходила до TCP вовсе). Без своего потолка такая попытка съедала
	// бы весь requestTimeout, ничего не отправив; с ним отказ виден за секунды, и
	// повтор успевает сработать.
	dialTimeout = 5 * time.Second
	// attempts — сколько раз пробуем один запрос. Ретрай ровно один: генерация
	// стоит денег, а провайдер, отказавший дважды, не станет доступнее с третьей
	// попытки. Ретраятся отказ транспорта, 5xx и пустой ответ; 4xx — нет, это наш
	// запрос, и повтор вернёт то же самое.
	attempts = 2
	// temperature — низкая: план формы это структура, а не сочинение; разброс
	// здесь означает лишь то, что одна и та же просьба даёт разные наборы полей.
	temperature = 0.3
)

// Client — клиент совместимого с OpenAI входа.
type Client struct {
	baseURL string
	apiKey  string
	model   string
	project string
	http    *http.Client
	log     *slog.Logger
}

// Options — что нужно клиенту. Значения приезжают из конфига контура (AI_*).
type Options struct {
	// BaseURL — база входа без хвостового слэша: путь дописывает клиент.
	BaseURL string
	APIKey  string
	// Model — идентификатор ровно как у провайдера. У Яндекс AI Studio это URI с
	// каталогом внутри (gpt://<каталог>/<модель>/latest), поэтому отдельного поля
	// «каталог» у клиента нет.
	Model string
	// Project — заголовок OpenAI-Project. Яндексу не нужен (права даёт ключ,
	// каталог едет внутри Model); пусто — заголовок не отправляется.
	Project    string
	HTTPClient *http.Client
	Log        *slog.Logger
}

func NewClient(o Options) *Client {
	httpClient := o.HTTPClient
	if httpClient == nil {
		// Свой транспорт, а не http.DefaultTransport: у дефолтного дозвон длится
		// 30 с, и на этом провайдере он оказался главным источником ожидания.
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.DialContext = (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext
		httpClient = &http.Client{Timeout: requestTimeout, Transport: transport}
	}
	log := o.Log
	if log == nil {
		log = slog.Default()
	}
	return &Client{
		baseURL: o.BaseURL,
		apiKey:  o.APIKey,
		model:   o.Model,
		project: o.Project,
		http:    httpClient,
		log:     log,
	}
}

var _ Generator = (*Client)(nil)

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type jsonSchemaSpec struct {
	Name string `json:"name"`
	// Strict — вход держит ответ в схеме сам. Проверено живым вызовом
	// (2026-09-01); вход, который так не умеет, ответит 4xx — то есть громко.
	Strict bool            `json:"strict"`
	Schema json.RawMessage `json:"schema"`
}

type responseFormat struct {
	Type       string          `json:"type"`
	JSONSchema *jsonSchemaSpec `json:"json_schema,omitempty"`
}

type chatRequest struct {
	Model          string          `json:"model"`
	Messages       []chatMessage   `json:"messages"`
	MaxTokens      int             `json:"max_tokens"`
	Temperature    float64         `json:"temperature"`
	ResponseFormat *responseFormat `json:"response_format,omitempty"`
}

type chatResponse struct {
	Choices []struct {
		FinishReason string `json:"finish_reason"`
		Message      struct {
			// Content приходит null, когда весь потолок токенов ушёл в
			// рассуждение модели: в строку это разворачивается пустотой, и
			// отличить её от «модель промолчала» не нужно — оба случая
			// ErrEmptyAnswer.
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Usage chatUsage `json:"usage"`
}

// chatUsage — сколько токенов стоил вызов. Нужен только логу: счётчик квоты
// считает вызовы, а не токены (ADR §10).
type chatUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

func (c *Client) Generate(ctx context.Context, req Request) (json.RawMessage, error) {
	if c.baseURL == "" || c.apiKey == "" || c.model == "" {
		return nil, ErrDisabled
	}
	body, err := json.Marshal(c.chatRequest(req))
	if err != nil {
		return nil, fmt.Errorf("ai: сборка запроса: %w", err)
	}

	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		started := time.Now()
		out, usage, retry, err := c.once(ctx, body)
		if err == nil {
			c.log.Info("ai answer",
				slog.String("model", c.model),
				slog.Int("attempt", attempt),
				slog.Int("prompt_tokens", usage.PromptTokens),
				slog.Int("completion_tokens", usage.CompletionTokens),
				slog.Int("answer_bytes", len(out)),
				slog.Duration("took", time.Since(started)))
			return out, nil
		}
		lastErr = err
		if !retry || ctx.Err() != nil {
			break
		}
		c.log.Warn("ai retry",
			slog.String("model", c.model),
			slog.Int("attempt", attempt),
			slog.String("reason", err.Error()),
			slog.Duration("took", time.Since(started)))
	}
	return nil, lastErr
}

func (c *Client) chatRequest(req Request) chatRequest {
	out := chatRequest{
		Model:       c.model,
		MaxTokens:   req.MaxTokens,
		Temperature: temperature,
		ResponseFormat: &responseFormat{
			Type: "json_object",
		},
	}
	if req.System != "" {
		out.Messages = append(out.Messages, chatMessage{Role: "system", Content: req.System})
	}
	out.Messages = append(out.Messages, chatMessage{Role: "user", Content: req.User})
	if len(req.Schema) > 0 {
		out.ResponseFormat = &responseFormat{
			Type: "json_schema",
			JSONSchema: &jsonSchemaSpec{
				Name:   req.SchemaName,
				Strict: true,
				Schema: req.Schema,
			},
		}
	}
	return out
}

// once — одна попытка. Второй результат — усилие модели (для лога), третий
// говорит, имеет ли смысл повтор.
func (c *Client) once(ctx context.Context, body []byte) (json.RawMessage, chatUsage, bool, error) {
	var usage chatUsage

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, usage, false, fmt.Errorf("ai: запрос: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	// Bearer, а не провайдерская схема: ключ Яндекса им принимается (проверено
	// 2026-09-01), а вход своего сервера другой и не знает.
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	if c.project != "" {
		httpReq.Header.Set("OpenAI-Project", c.project)
	}

	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, usage, true, fmt.Errorf("%w: %v", ErrProvider, err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, usage, true, fmt.Errorf("%w: чтение ответа: %v", ErrProvider, err)
	}
	if resp.StatusCode != http.StatusOK {
		// Текст отказа — в лог, не наружу: автору формы он ничего не даёт.
		c.log.Error("ai provider refused",
			slog.String("model", c.model),
			slog.Int("status", resp.StatusCode),
			slog.String("body", string(raw)))
		return nil, usage, resp.StatusCode >= 500, fmt.Errorf("%w: статус %d", ErrProvider, resp.StatusCode)
	}

	var parsed chatResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, usage, true, fmt.Errorf("%w: неразбираемый ответ: %v", ErrProvider, err)
	}
	usage = parsed.Usage
	if len(parsed.Choices) == 0 || parsed.Choices[0].Message.Content == "" {
		finish := ""
		if len(parsed.Choices) > 0 {
			finish = parsed.Choices[0].FinishReason
		}
		return nil, usage, true, fmt.Errorf("%w (finish_reason=%q, completion_tokens=%d)",
			ErrEmptyAnswer, finish, parsed.Usage.CompletionTokens)
	}
	return json.RawMessage(parsed.Choices[0].Message.Content), usage, false, nil
}
