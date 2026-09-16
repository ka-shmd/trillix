package domain

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"time"
)

// ПОДПИСЬ ЗАПРОСА ВЕБХУКА (фаза 28 `DEV-PLAN`, контракт v1 — design/webhooks.md §7,
// ADR §10). Публичный контракт: получатель сверяет подпись своим кодом, и любая
// правка формата ломает всех, кто уже подключился.
//
// v1 = hex(HMAC-SHA256(секрет, t + "." + тело)), t — время отправки в секундах.
// Ключ HMAC — секрет РОВНО в том виде, в каком его видит автор формы (строкой, с
// префиксом): так проверка на стороне получателя — одна команда
// `openssl dgst -sha256 -hmac "$SECRET"`, без разбора формата секрета.
// Время внутри подписи защищает получателя от повтора перехваченного запроса.

// WebhookSignatureHeader — заголовок, в котором едет подпись.
const WebhookSignatureHeader = "Trillix-Signature"

// SignWebhook — значение заголовка подписи: `t=<unix>,v1=<hex>`.
func SignWebhook(secret string, at time.Time, body []byte) string {
	ts := strconv.FormatInt(at.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts))
	mac.Write([]byte{'.'})
	mac.Write(body)
	return "t=" + ts + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

// ТЕЛО ЗАПРОСА (контракт v1, спека §7). Публичный контракт: получатель разбирает
// его своим кодом, поэтому поля не переименовываются и не исчезают, а новые
// добавляются без смены версии — незнакомые получатель обязан игнорировать.
//
// Значения — СТРОКАМИ, той же моделью колонок, что у выгрузки и у Google Таблиц
// (CSVBuilder): подписи опций вместо id, время записи в поясе расписания, имена
// файлов без ссылок. Типизированный вид стал бы ещё одной поверхностью, которую
// обязан реализовать каждый будущий тип поля; его место — version 2.

// WebhookEventSubmission — единственное событие контракта v1.
const WebhookEventSubmission = "submission.created"

// WebhookPayloadVersion — версия контракта.
const WebhookPayloadVersion = 1

// WebhookField — один вопрос формы в теле запроса. Key — id блока: подпись
// автор переименует, а разметка полей у получателя переживёт это.
type WebhookField struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

// WebhookPayload — тело запроса целиком.
type WebhookPayload struct {
	Version int    `json:"version"`
	Event   string `json:"event"`
	// Test — образец, отправленный кнопкой «Проверить», а не настоящий ответ.
	Test       bool              `json:"test,omitempty"`
	Form       WebhookForm       `json:"form"`
	Submission WebhookSubmission `json:"submission"`
}

type WebhookForm struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type WebhookSubmission struct {
	ID          string         `json:"id"`
	SubmittedAt string         `json:"submittedAt"`
	FormVersion int            `json:"formVersion"`
	Fields      []WebhookField `json:"fields"`
}

// WebhookFields — ответы по вопросам формы для тела запроса. Список — ВСЕ
// вопросы по всем версиям, как колонки выгрузки: ключи не исчезают при правке
// формы, и разметка полей у получателя не рассыпается. Неотвеченный вопрос,
// скрытый логикой и вопрос не из этой версии дают пустую строку.
func (b *CSVBuilder) WebhookFields(version int, answers map[string]json.RawMessage) []WebhookField {
	// Значения берутся из той же строки, что уезжает в таблицу: два способа
	// сформатировать один ответ однажды разошлись бы.
	row := b.row("", time.Time{}, version, answers)
	values := row[len(csvMetaHeader):]

	out := make([]WebhookField, 0, len(b.columns))
	for i, key := range b.columns {
		out = append(out, WebhookField{
			Key:   key,
			Label: b.headers[len(csvMetaHeader)+i],
			Type:  string(b.types[i]),
			Value: values[i],
		})
	}
	return out
}

// WebhookSampleFields — образец для кнопки «Проверить»: те же вопросы с
// примерными значениями. Пустые значения не годятся — получатель (Zapier, Make)
// строит по образцу разметку полей, и поле без значения он не покажет.
func (b *CSVBuilder) WebhookSampleFields() []WebhookField {
	out := make([]WebhookField, 0, len(b.columns))
	for i, key := range b.columns {
		out = append(out, WebhookField{
			Key:   key,
			Label: b.headers[len(csvMetaHeader)+i],
			Type:  string(b.types[i]),
			Value: sampleValue(b.types[i], b.optionsOf(key)),
		})
	}
	return out
}

// optionsOf — подписи опций вопроса из САМОЙ СВЕЖЕЙ версии, где он есть: там же,
// откуда взята его подпись (QuestionOrder).
func (b *CSVBuilder) optionsOf(blockID string) []string {
	for v := len(b.byVer); v >= 1; v-- {
		view, ok := b.byVer[v][blockID]
		if !ok {
			continue
		}
		out := make([]string, 0, len(view.options))
		for _, label := range view.options {
			out = append(out, label)
		}
		sort.Strings(out) // карта опций неупорядочена, а образец обязан быть одинаковым
		return out
	}
	return nil
}

// sampleValue — примерное значение вопроса для образца. Ветка на тип, а НЕ ещё
// одна поверхность у типа поля: незнакомый тип честно получает общий текст, и
// новый тип поля этот файл править не заставляет.
func sampleValue(t BlockType, options []string) string {
	switch {
	case t.isChoice() && len(options) > 0:
		if t.isMultiChoice() && len(options) > 1 {
			return options[0] + "; " + options[1]
		}
		return options[0]
	case t == BlockEmail:
		return "primer@example.com"
	case t == BlockPhone:
		return "+7 900 000-00-00"
	case t == BlockNumber, t.isScaleLike():
		return "5"
	case t == BlockDate:
		return "2026-09-12"
	case t == BlockSlot:
		return "12.09.2026 11:00"
	case t == BlockFile:
		return "пример.pdf"
	default:
		return "Пример ответа"
	}
}
