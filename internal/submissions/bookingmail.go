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
		},
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
	timezone string,
) {
	log := httpserver.LoggerFrom(ctx)
	if s.bookingOrganizer == "" {
		return
	}
	row, err := s.repo.GetForPrint(ctx, s.db, formID, submissionID)
	if err != nil {
		log.Warn("submission not read for booking cancel mail",
			slog.String("submission_id", submissionID.String()), slog.String("error", err.Error()))
		return
	}
	schema, err := domain.ValidateSchema(row.Schema)
	if err != nil {
		log.Warn("schema not parsed for booking cancel mail",
			slog.String("submission_id", submissionID.String()), slog.String("error", err.Error()))
		return
	}
	var answers map[string]json.RawMessage
	if err := json.Unmarshal(row.Answers, &answers); err != nil {
		log.Warn("answers not parsed for booking cancel mail",
			slog.String("submission_id", submissionID.String()), slog.String("error", err.Error()))
		return
	}
	owner, err := s.forms.SubmissionOwner(ctx, formID)
	if err != nil {
		log.Warn("submission owner not resolved for booking cancel mail",
			slog.String("form_id", formID.String()), slog.String("error", err.Error()))
		return
	}
	to := domain.BookingAddress(owner.RespondentEmail, schema, answers)
	if to == "" {
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
		},
		// SEQUENCE 1 — БОЛЬШЕ, чем у приглашения (0): клиент вправе проигнорировать
		// отмену с номером не выше выданного, приняв её за устаревшую.
		Inline: []mail.File{s.invite(domain.ICSCancel, 1, b, owner.PublicTitle, to, "")},
	}
	if err := s.mail.EnqueueEmail(ctx, s.db, msg); err != nil {
		log.Warn("booking cancel mail not enqueued",
			slog.String("submission_id", submissionID.String()), slog.String("error", err.Error()))
	}
}
