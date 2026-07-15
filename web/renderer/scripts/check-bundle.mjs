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

// Считаем весь клиентский JS в dist/: стабильный entry `renderer.js` лежит в
// корне (Go ссылается на него по фиксированному пути, фаза 7), а code-split-чанки
// (если появятся) — под assets/. Обходим dist/ рекурсивно и берём все .js.
const distDir = fileURLToPath(new URL('../dist/', import.meta.url))

function jsFilesUnder(dir, prefix = '') {
  let out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const nested = jsFilesUnder(dir + e.name + '/', prefix + e.name + '/')
      if (nested) out = out.concat(nested)
    } else if (e.name.endsWith('.js')) {
      out.push({ label: prefix + e.name, path: dir + e.name })
    }
  }
  return out
}

const jsFiles = jsFilesUnder(distDir)
if (jsFiles === null) {
  console.error(`✗ нет собранной сборки в ${distDir} — сначала 'npm run build'`)
  process.exit(1)
}
if (jsFiles.length === 0) {
  console.error(`✗ в ${distDir} нет .js — сборка пуста?`)
  process.exit(1)
}

// Считаем сумму gzip-размеров всех JS-файлов — так же, как их отдаёт браузеру
// сервер со сжатием (те же числа, что печатает vite build).
let total = 0
const kib = (n) => (n / 1024).toFixed(2) + ' KiB'
for (const f of jsFiles) {
  const size = gzipSync(readFileSync(f.path)).length
  total += size
  console.log(`  ${f.label}  ${kib(size)} gzip`)
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
