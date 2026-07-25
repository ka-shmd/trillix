import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'

// Сессия кабинета БЕЗ UI-регистрации.
//
// Почему так: каждый сценарий заводит свою учётку, а `POST /auth/register` сидит под
// своим ведром лимитера (`registerBurst = 3`, пополнение ~1/30 с — `cmd/api/main.go`).
// Три существующих сценария расходуют бурст ровно в ноль, поэтому четвёртый упирался
// бы в 429 и выглядел бы сломавшимся тестом. Лимит ради тестов не ослабляется
// (инвариант 6), значит учётка заводится мимо HTTP — подкомандой `api seed-user`
// внутри контейнера prod-local (тот же сервисный вызов, что и у `make seed`).
//
// Вход после этого — обычный `POST /auth/login`: своё ведро (`loginBurst = 5`), CSRF
// на нём не требуется (сессии ещё нет), а куки садятся прямо в контекст страницы,
// поэтому дальше и `page.goto`, и `page.request` ходят авторизованными.

// Контейнер api prod-local. Имя — дефолтное compose'овское: проект (`-p
// trillix-prod-local` в Makefile) + сервис + индекс. Переопределяется переменной
// окружения, если стек поднят под другим именем проекта.
const API_CONTAINER = process.env.E2E_API_CONTAINER ?? 'trillix-prod-local-api-1'

export const SEED_PASSWORD = 'supersecret123'

// seedAccount заводит учётку и возвращает её email. Идемпотентна на стороне команды,
// но адрес всё равно уникальный: сценарий не должен видеть формы прошлого прогона.
export function seedAccount(prefix: string): string {
  const email = `${prefix}-${Date.now()}@example.com`
  try {
    // stderr забираем в строку, а не наружу: у execFileSync своё сообщение
    // («Command failed: docker exec …»), и без перехвата причина до отчёта не
    // доезжает — падение выглядит немым.
    execFileSync('docker', ['exec', API_CONTAINER, '/api', 'seed-user', email, SEED_PASSWORD], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    })
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    const out = err.stderr ?? ''
    // Самая частая причина на живущем стеке: контейнер поднят на образе, собранном
    // ДО появления подкоманды. Стек не пересобирается сам — `up -d` не трогает
    // контейнер, у которого образ с тем же тегом уже был. CI этого не видит (там
    // `make prod-local` собирает образ каждый прогон), поэтому подсказка нужна здесь.
    if (out.includes('unknown command')) {
      throw new Error(
        `В контейнере ${API_CONTAINER} бинарник без подкоманды seed-user — стек поднят ` +
          'на старом образе. Пересоберите prod-local: `make prod-local`.',
      )
    }
    throw new Error(`seed-user (${API_CONTAINER}): ${out.trim() || err.message}`)
  }
  return email
}

// login кладёт сессию в контекст страницы. Отдельным шагом от seedAccount: сидинг
// идёт мимо приложения, а вход — настоящий, через ту же ручку, что и у людей.
export async function login(page: Page, email: string): Promise<void> {
  const res = await page.request.post('/api/v1/auth/login', {
    data: { email, password: SEED_PASSWORD },
  })
  if (!res.ok()) {
    throw new Error(`login ${email}: ${res.status()} ${await res.text()}`)
  }
}
