import { defineConfig, devices } from '@playwright/test'

// Отдельный конфиг у замера — не косметика: оснастка перф-замера НЕ должна попадать в
// `npm test`. Она ничего не утверждает (нет ассертов про поведение), идёт минуты и
// требует свежесобранного prod-local — в наборе смоуков ей делать нечего.
//
// Всё остальное зеркалит tests-конфиг: тот же уже поднятый prod-local, тот же обход
// недоверенного локального CA.
export default defineConfig({
  testDir: './perf',
  timeout: 15 * 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_APP_URL ?? 'https://app.localhost',
    ignoreHTTPSErrors: true,
    // Замер геометрии зависит от размера окна: узкое окно свернуло бы ряды в столбик
    // и поменяло состав droppable'ов. Фиксируем десктоп.
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
