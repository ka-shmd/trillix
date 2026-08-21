import { describe, expect, it } from 'vitest'

import { displayName, initials, userSchema, type User } from './user'

function user(patch: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'ivan@example.com',
    emailVerified: true,
    firstName: '',
    lastName: '',
    hasPassword: true,
    avatarKey: '',
    twoFactorEnabled: false,
    ...patch,
  }
}

describe('displayName', () => {
  it('без имени зовёт по email', () => {
    expect(displayName(user())).toBe('ivan@example.com')
  })

  it('имя и фамилия склеиваются пробелом', () => {
    expect(displayName(user({ firstName: 'Иван', lastName: 'Петров' }))).toBe('Иван Петров')
  })

  // Половина профиля — обычное состояние: фамилия необязательна. Лишний пробел
  // на конце виден в сайдбаре и в первой букве аватара, поэтому пустые части
  // отбрасываются, а не подставляются.
  it('одно заполненное поле не даёт лишних пробелов', () => {
    expect(displayName(user({ firstName: 'Иван' }))).toBe('Иван')
    expect(displayName(user({ lastName: 'Петров' }))).toBe('Петров')
  })
})

// Цепочка фолбэков кружка: инициалы имени и фамилии → одна буква того, что
// заполнено → первая буква email. Кружок есть у каждого аккаунта, поэтому
// пустого результата у этой функции быть не может.
describe('initials', () => {
  it('имя и фамилия дают две буквы', () => {
    expect(initials(user({ firstName: 'Иван', lastName: 'Петров' }))).toBe('ИП')
  })

  it('половина профиля даёт одну букву', () => {
    expect(initials(user({ firstName: 'иван' }))).toBe('И')
    expect(initials(user({ lastName: 'петров' }))).toBe('П')
  })

  it('без имени берётся первая буква почты', () => {
    expect(initials(user())).toBe('I')
  })

  // Пробелы в профиле — обычное состояние: сервер их подрезает, но кэш кабинета
  // может держать значение, введённое до сохранения.
  it('строка из пробелов именем не считается', () => {
    expect(initials(user({ firstName: '   ' }))).toBe('I')
  })
})

describe('userSchema', () => {
  // Профиль в схеме обязателен: сервер шлёт пустую строку вместо null, и
  // необязательное поле здесь означало бы undefined в displayName у каждого
  // потребителя.
  it('ответ без профиля не проходит границу', () => {
    const res = userSchema.safeParse({ id: 'u1', email: 'a@b.com', emailVerified: false })
    expect(res.success).toBe(false)
  })
})
