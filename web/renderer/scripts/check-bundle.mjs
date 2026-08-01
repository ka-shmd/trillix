// Бюджет размера бандла рендерера. Публичная форма должна грузиться мгновенно
// даже на телефоне по мобильной сети, поэтому вес клиентского кода — бюджетируемый
// ресурс (web/CLAUDE.md: зона жёсткой экономии). Проверка гоняется в CI после
// сборки; превышение валит сборку — регрессия веса видна в PR, а не на проде.
//
// Порог опущен с 95 до 45 КиБ вместе со свапом рантайма на preact/compat: React +
// react-dom съедали почти весь прежний бюджет сами, без них сборка весит ~33 КиБ
// (замер на момент свапа — 32.82). Держать после этого прежние 95 значило бы иметь
// бюджет, который не ловит ничего, кроме катастрофы: до него можно молча дорастить
// вес втрое. Запас ~12 КиБ оставлен на рост фич рендерера (условная логика, файлы в
// ответах); упереться в порог — повод не поднимать число, а посмотреть, что именно
// приехало в публичную форму.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const BUDGET_BYTES = 45 * 1024

// Считаем весь клиентский JS в dist/: entry и code-split-чанки лежат под assets/
// с хешированными именами (vite-дефолт). Обходим dist/ рекурсивно и берём все .js —
// имена не важны, поэтому переход на хеши сборку не ломает.
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
