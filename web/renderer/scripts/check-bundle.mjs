// Бюджет размера бандла рендерера. Публичная форма должна грузиться мгновенно
// даже на телефоне по мобильной сети, поэтому вес клиентского кода — бюджетируемый
// ресурс (web/CLAUDE.md: зона жёсткой экономии). Проверка гоняется в CI после
// сборки; превышение валит сборку — регрессия веса видна в PR, а не на проде.
//
// Порог поднят выше исходных 60 КБ gzip из DEV-PLAN: один только React + react-dom
// исчерпывают столько, а рендерер тянет ещё zod для валидации схемы (фаза 4). Число
// с запасом на рост фич, но ловит случайно затащенную тяжёлую зависимость. Если
// из-за веса не возьмётся Lighthouse ≥90 — запасной выход из плана — свап на
// preact/compat (алиас только в сборке рендерера), тогда порог опустится.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const BUDGET_BYTES = 95 * 1024

const assetsDir = fileURLToPath(new URL('../dist/assets/', import.meta.url))

let jsFiles
try {
  jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
} catch {
  console.error(`✗ нет собранных ассетов в ${assetsDir} — сначала 'npm run build'`)
  process.exit(1)
}
if (jsFiles.length === 0) {
  console.error(`✗ в ${assetsDir} нет .js — сборка пуста?`)
  process.exit(1)
}

// Считаем сумму gzip-размеров всех JS-чанков — так же, как их отдаёт браузеру
// сервер со сжатием (те же числа, что печатает vite build).
let total = 0
const kib = (n) => (n / 1024).toFixed(2) + ' KiB'
for (const f of jsFiles) {
  const size = gzipSync(readFileSync(assetsDir + f)).length
  total += size
  console.log(`  ${f}  ${kib(size)} gzip`)
}

console.log(`\nИтого JS: ${kib(total)} gzip · бюджет ${kib(BUDGET_BYTES)}`)
if (total > BUDGET_BYTES) {
  console.error(
    `✗ бюджет бандла превышен на ${kib(total - BUDGET_BYTES)}. ` +
      `Уменьши код/зависимости или согласуй новый порог в check-bundle.mjs.`,
  )
  process.exit(1)
}
console.log('✓ в пределах бюджета')
