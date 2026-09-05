package submissions

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	netmail "net/mail"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/mail"
)

// СЛУЖЕБНОЕ ПИСЬМО ЗАПИСИ (фаза 27, design/booking.md §4.8).
//
// Отдельное от квитанции автора и НЕГЕЙТИМОЕ: отмена — механизм самого расписания, а
// не любезность респонденту. Ссылка отмены в квитанции означала бы, что на бесплатном
// тарифе место до самого приёма стоит занятым, и теряет от этого прежде всего автор.
//
// Автор его не настраивает и не отключает; антиспам-обвязку оно наследует у квитанции
// целиком — тот же потолок писем на форму и такой же неудаляемый подвал, потому что
// адрес приезжает ответом на форму, то есть его вводит кто угодно.

// WithBookingMail включает письмо о записи. organizer — адрес отправителя контура
// (MAIL_FROM): он уезжает ORGANIZER'ом в приглашение календаря. Пусто — письма нет:
// приглашение без организатора часть клиентов не показывает вовсе.
func (s *Service) WithBookingMail(organizer string) *Service {
	if addr, err := netmail.ParseAddress(organizer); err == nil {
		organizer = addr.Address
	}
	s.bookingOrganizer = organizer
	return s
}

// notifyBooking ставит письмо о состоявшейся записи. Best-effort, как и остальные
// побочные эффекты приёма: ни один из них не имеет права уронить принятый ответ.
func (s *Service) notifyBooking(
	ctx context.Context,
	formID, submissionID uuid.UUID,
	slug string,
	schema domain.FormSchema,
	answers map[string]json.RawMessage,
	b slotBooking,
) {
	log := httpserver.LoggerFrom(ctx)
	if s.bookings == nil || s.bookingOrganizer == "" || s.formBaseURL == "" {
		log.Warn("booking mail is not configured on this deployment",
			slog.String("form_id", formID.String()))
		return
	}
	owner, err := s.forms.SubmissionOwner(ctx, formID)
	if err != nil {
		log.Warn("submission owner not resolved for booking mail",
			slog.String("form_id", formID.String()), slog.String("error", err.Error()))
		return
	}
	to := domain.BookingAddress(owner.RespondentEmail, schema, answers)
	if to == "" {
		// Вопроса про почту в форме нет или он не заполнен: письма не будет, а
		// значит, не будет и ссылки отмены. Полотно предупреждает об этом автора —
		// здесь молчим, потому что респондент ни при чём.
		return
	}
	// Потолок писем на форму — тот же, что у квитанции: адрес вводит кто угодно, и
	// защищает он получателя, а не нас.
	if s.respondentLimiter != nil && !s.respondentLimiter.Allow(formID.String()) {
		log.Warn("booking mail throttled", slog.String("form_id", formID.String()))
		return
	}

	link := s.bookings.CancelLink(b.BookingID)
	when := bookingWhen(b.StartsAt, b.Timezone)
	msg := mail.EmailMessage{
		To:       to,
		Template: mail.TemplateBookingConfirmed,
		Data: map[string]any{
			"form_title":  owner.PublicTitle,
			"when":        when,
			"cancel_link": link,
			"form_link":   s.formBaseURL + "/r/" + slug,
		},
		// SEQUENCE 0 — нулевой номер редакции события: письмо о самой записи уходит
		// в момент её создания, когда `bookings.revision` ещё нулевой. Дальше номер
		// ведёт сама строка, и присылает его тот, кто её правил.
		Inline: []mail.File{s.invite(domain.ICSRequest, 0, b, owner.PublicTitle, to, link)},
	}
	if err := s.mail.EnqueueEmail(ctx, s.db, msg); err != nil {
		log.Warn("booking mail not enqueued",
			slog.String("submission_id", submissionID.String()), slog.String("error", err.Error()))
	}
}

// invite собирает приглашение календаря. UID постоянный — он выведен из id брони,
// поэтому отмена (слайс H) гасит ровно это событие, а не создаёт второе.
func (s *Service) invite(method domain.ICSMethod, sequence int, b slotBooking, title, to, link string) mail.File {
	duration := time.Duration(b.DurationMinutes) * time.Minute
	if duration <= 0 {
		duration = time.Hour
	}
	doc := domain.ICS(domain.CalendarEvent{
		UID:         BookingUID(b.BookingID),
		Sequence:    sequence,
		Method:      method,
		Summary:     "Запись: " + title,
		StartsAt:    b.StartsAt,
		EndsAt:      b.StartsAt.Add(duration),
		Organizer:   s.bookingOrganizer,
		Attendee:    to,
		Description: link,
		Stamp:       s.now().UTC(),
	})
	return mail.File{
		Name: "invite.ics",
		// method в типе части обязателен: без него клиент считает файл просто
		// вложением и кнопки «Принять» не показывает.
		MIME:    fmt.Sprintf("text/calendar; charset=utf-8; method=%s", method),
		Content: doc,
	}
}

// BookingUID — постоянный идентификатор события календаря. Выводится из id брони и
// НЕ МЕНЯЕТСЯ между приглашением и его отменой: разойдись они, отмена создала бы у
// человека второе событие вместо того, чтобы погасить первое.
func BookingUID(bookingID uuid.UUID) string {
	return "booking-" + bookingID.String() + "@trillix"
}

// bookingWhen — время записи словами, в поясе РАСПИСАНИЯ и с его именем: «11 сентября
// 2026, 11:00 (Europe/Moscow)».
//
// Пояса читателя сервер не знает — письмо открывают где угодно, — поэтому написать
// «в обоих» тут нечем. Зато пояс назван прямо: человек, читающий письмо из другого
// города, видит, по какому времени его ждут. Само событие в приложенном приглашении
// лежит в UTC, и календарь покажет его в местном времени сам.
func bookingWhen(at time.Time, timezone string) string {
	loc, err := domain.LoadScheduleLocation(timezone)
	if err != nil {
		loc = time.UTC
	}
	local := at.In(loc)
	return fmt.Sprintf("%d %s %d, %s (%s)",
		local.Day(), monthsGenitive[local.Month()-1], local.Year(), local.Format("15:04"), timezone)
}

// monthsGenitive — месяцы в родительном падеже: Go форматирует даты только
// по-английски, а письмо читает человек. Тот же список, что у формата дат кабинета
// (web/app/src/shared/format.ts) — разъезжаться им незачем, но общего места у Go и
// фронта здесь нет.
var monthsGenitive = [12]string{
	"января", "февраля", "марта", "апреля", "мая", "июня",
	"июля", "августа", "сентября", "октября", "ноября", "декабря",
}

// NotifyBookingCanceled ставит письмо об отмене записи — тем же адресатом и с тем же
// UID события, но методом CANCEL: календарь получателя гасит встречу, а не заводит
// вторую (design/booking.md §11).
//
// Зовёт его модуль записи (booking.CancelNotifier) — и по ссылке из письма, и из
// кабинета. Best-effort: письмо не имеет права отменить отмену.
func (s *Service) NotifyBookingCanceled(
	ctx context.Context,
	formID, submissionID, bookingID uuid.UUID,
	startsAt time.Time,
	durationMinutes int,
	sequence int,
	timezone string,
) {
	log := httpserver.LoggerFrom(ctx)
	if s.bookingOrganizer == "" || s.formBaseURL == "" {
		// Те же две настройки, что у письма о записи: без организатора приглашение
		// не покажет половина клиентов, без адреса формы подвалу нечем объяснить
		// получателю, откуда письмо взялось.
		return
	}
	owner, to, ok := s.bookingRecipient(ctx, formID, submissionID, "cancel")
	if !ok {
		return
	}

	b := slotBooking{
		BookingID:       bookingID,
		StartsAt:        startsAt,
		DurationMinutes: durationMinutes,
		Timezone:        timezone,
	}
	msg := mail.EmailMessage{
		To:       to,
		Template: mail.TemplateBookingCanceled,
		Data: map[string]any{
			"form_title": owner.PublicTitle,
			"when":       bookingWhen(startsAt, timezone),
			"form_link":  s.formBaseURL + "/r/" + owner.Slug,
		},
		// НОМЕР ПРИСЫЛАЕТ МОДУЛЬ ЗАПИСИ, и он всегда больше выданного: клиент вправе
		// проигнорировать отмену с номером не выше принятого, приняв её за
		// устаревшую. Константы здесь стояла единица — она врала с первого же
		// переноса, потому что перенос тоже уезжает REQUEST'ом и поднимает номер.
		Inline: []mail.File{s.invite(domain.ICSCancel, sequence, b, owner.PublicTitle, to, "")},
	}
	if err := s.mail.EnqueueEmail(ctx, s.db, msg); err != nil {
		log.Warn("booking cancel mail not enqueued",
			slog.String("submission_id", submissionID.String()), slog.String("error", err.Error()))
	}
}

// bookingRecipient — кому и от чьего имени слать письмо о чужой встрече.
//
// АДРЕС ЖИВЁТ В ОТВЕТЕ ФОРМЫ, а не в строке брони (0050): чтобы его получить, надо
// поднять ответ, разобрать схему опубликованной версии и найти в ней вопрос про
// почту. Одно и то же нужно и отмене, и переносу — порознь эти сорок строк разъехались
// бы молча, и одно из писем стало бы уходить не туда.
//
// ok = false означает «письма не будет», и это не всегда ошибка: у формы может не быть
// вопроса про почту вовсе, а у брони — ответа (его удалили).
func (s *Service) bookingRecipient(
	ctx context.Context, formID, submissionID uuid.UUID, purpose string,
) (forms.Owner, string, bool) {
	log := httpserver.LoggerFrom(ctx)
	row, err := s.repo.GetForPrint(ctx, s.db, formID, submissionID)
	if err != nil {
		log.Warn("submission not read for booking mail",
			slog.String("purpose", purpose),
			slog.String("submission_id", submissionID.String()), slog.String("error", err.Error()))
		return forms.Owner{}, "", false
	}
	schema, err := domain.ValidateSchema(row.Schema)
	if err != nil {
		log.Warn("schema not parsed for booking mail",
			slog.String("purpose", purpose),
			slog.String("submission_id", submissionID.String()), slog.String("error", err.Error()))
		return forms.Owner{}, "", false
	}
	var answers map[string]json.RawMessage
	if err := json.Unmarshal(row.Answers, &answers); err != nil {
		log.Warn("answers not parsed for booking mail",
			slog.String("purpose", purpose),
			slog.String("submission_id", submissionID.String()), slog.String("error", err.Error()))
		return forms.Owner{}, "", false
	}
	owner, err := s.forms.SubmissionOwner(ctx, formID)
	if err != nil {
		log.Warn("submission owner not resolved for booking mail",
			slog.String("purpose", purpose),
			slog.String("form_id", formID.String()), slog.String("error", err.Error()))
		return forms.Owner{}, "", false
	}
	to := domain.BookingAddress(owner.RespondentEmail, schema, answers)
	if to == "" {
		return forms.Owner{}, "", false
	}
	return owner, to, true
}

// NotifyBookingRescheduled ставит письмо о переносе записи.
//
// МЕТОД REQUEST, А НЕ CANCEL, и UID тот же: календарь получателя ДВИГАЕТ встречу, а
// не заводит вторую рядом с погашенной. Номер редакции присылает модуль записи — он
// растёт в той же транзакции, что переносит бронь (0052), и приглашение с номером не
// больше принятого клиент вправе отбросить.
//
// Зовёт его только кабинет: у респондента переноса нет, в письме у него одна кнопка —
// отменить (ADR §10). Best-effort: письмо не имеет права отменить состоявшийся перенос.
func (s *Service) NotifyBookingRescheduled(
	ctx context.Context,
	formID, submissionID, bookingID uuid.UUID,
	wasAt, startsAt time.Time,
	durationMinutes int,
	sequence int,
	timezone string,
) {
	log := httpserver.LoggerFrom(ctx)
	if s.bookingOrganizer == "" || s.formBaseURL == "" {
		return
	}
	owner, to, ok := s.bookingRecipient(ctx, formID, submissionID, "reschedule")
	if !ok {
		return
	}

	b := slotBooking{
		BookingID:       bookingID,
		StartsAt:        startsAt,
		DurationMinutes: durationMinutes,
		Timezone:        timezone,
	}
	// Ссылка отмены остаётся ЖИВОЙ и едет снова: перенос её не гасит (подпись
	// покрывает id брони, а он не менялся), а письмо о переносе — последнее, что у
	// человека на руках, и отменять он будет из него.
	link := ""
	if s.bookings != nil {
		link = s.bookings.CancelLink(bookingID)
	}
	msg := mail.EmailMessage{
		To:       to,
		Template: mail.TemplateBookingRescheduled,
		Data: map[string]any{
			"form_title":  owner.PublicTitle,
			"was":         bookingWhen(wasAt, timezone),
			"when":        bookingWhen(startsAt, timezone),
			"cancel_link": link,
			"form_link":   s.formBaseURL + "/r/" + owner.Slug,
		},
		Inline: []mail.File{s.invite(domain.ICSRequest, sequence, b, owner.PublicTitle, to, link)},
	}
	if err := s.mail.EnqueueEmail(ctx, s.db, msg); err != nil {
		log.Warn("booking reschedule mail not enqueued",
			slog.String("submission_id", submissionID.String()), slog.String("error", err.Error()))
	}
}
