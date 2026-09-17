import { z } from 'zod'

// Единственный источник типа пользователя: Zod-схема, TS-тип выводится из неё
// (web/CLAUDE.md — руками интерфейсы не дублируем). Форма ответа /auth/*.
export const userSchema = z.object({
  id: z.string(),
  email: z.email(),
  // Подтверждён ли email (слайс C): по нему кабинет рисует баннер «подтвердите
  // почту». Приезжает во всех ответах /auth/* (register/login/me/link).
  emailVerified: z.boolean(),
  // Имя человека (фаза 23). Пустая строка = не указано: в БД там NULL, но на
  // границе оба состояния сведены к строке — иначе каждый потребитель имени
  // разбирался бы с null сам, а показать он всё равно может только строку.
  firstName: z.string(),
  lastName: z.string(),
  // Есть ли у аккаунта пароль: у заведённого через провайдера его нет, и
  // раздел настроек называется «Задать пароль», а текущий не спрашивается.
  hasPassword: z.boolean(),
  // Ключ картинки аватара в хранилище, не адрес: URL собирает mediaSrc
  // (@fields/media) — то же правило, что у settings.imageKey в схеме формы.
  // Пустая строка = аватара нет, рисуется кружок с инициалами.
  avatarKey: z.string(),
  // Включён ли второй фактор (фаза 23, слайс F). Флаг живёт в своей таблице на
  // бэке, но на границе едет полем профиля: экран настроек и вход спрашивают
  // именно его.
  twoFactorEnabled: z.boolean(),
})

export type User = z.infer<typeof userSchema>

// Ответ /auth/me — пользователь и признак гейта согласия: закрыт ли кабинет до принятия
// действующей редакции Пользовательского соглашения (docs/design/signup-consent.md §3.2).
// Только у /auth/me: остальные ручки отвечают профилем, поэтому кэш me ими сливается, а
// не заменяется (patchMe в features/auth/queries.ts).
export const meSchema = userSchema.extend({
  consentRequired: z.boolean(),
})

export type Me = z.infer<typeof meSchema>

// initials — что написать в кружке, когда картинки нет: инициалы имени и
// фамилии, а если их нет — первая буква email. Одна точка на весь кабинет, как
// и displayName: сайдбар, настройки и список участников обязаны показывать
// человека одинаково.
//
// Принимает поля, а не User, потому что участник пространства — не User (у него
// нет ни пароля, ни второго фактора), а кружок у них общий.
export function initials(person: { firstName: string; lastName: string; email: string }): string {
  const letters = [person.firstName, person.lastName]
    .map((part) => part.trim().charAt(0))
    .filter((ch) => ch !== '')
    .join('')
  return (letters === '' ? person.email.charAt(0) : letters).toUpperCase()
}

// displayName — как человека зовут в интерфейсе: имя, если оно есть, иначе
// email. Одна точка на весь кабинет: сайдбар, шапка и список участников обязаны
// звать человека одинаково.
//
// Принимает поля, а не User, по той же причине, что initials выше: участник
// пространства — не User (у него нет ни пароля, ни второго фактора), а зовут их
// в интерфейсе одинаково.
export function displayName(person: { firstName: string; lastName: string; email: string }): string {
  const full = [person.firstName, person.lastName].filter((p) => p !== '').join(' ')
  return full === '' ? person.email : full
}
