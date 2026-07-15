# E2e (Playwright) — сквозной smoke против prod-local

Один сценарий (ARCHITECTURE §8): регистрация → собрать форму слэш-редактором →
опубликовать → ответить с мобильного вьюпорта → увидеть ответ в таблице → скачать
CSV. Гоняет **собранный** продукт в реальном браузере — ловит класс багов
«прод-сборка ≠ dev» (пустая форма без entry-скрипта, форма без стилей), которые не
видят ни Go-, ни vitest-тесты.

## Запуск (локально)

Нужен поднятый prod-local (тест ходит на `https://app.localhost` / `https://f.localhost`):

```
make prod-local            # из корня репо — поднять стек
cd e2e && npm ci
npx playwright install chromium   # один раз
npm test
```

Chromium сам резолвит `*.localhost` в 127.0.0.1; недоверенный локальный CA Caddy
обходится `ignoreHTTPSErrors` (TLS настоящий, просто не доверенный).

## Переопределение адресов

`E2E_APP_URL` и `E2E_RENDERER_URL` — на случай других хостов (по умолчанию
`https://app.localhost` и `https://f.localhost`).

## CI

Job поднимается отдельно (не на каждый PR — стек тяжёлый): `workflow_dispatch` +
nightly (шаг 7b фазы 7).
