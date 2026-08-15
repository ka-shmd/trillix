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

// Загрузчик встроенной формы (dist/embed/v1.js, фаза 20) считается ОТДЕЛЬНО и своим
// порогом. Он не часть публичной формы: грузится на ЧУЖОЙ странице, где мы гости, и
// сложенный с формой не значил бы ничего — ни один посетитель не скачивает оба веса
// за раз. Общий счёт вдобавок тихо съел бы запас рендерера: 4 КиБ — это почти
// половина того, что у него осталось до порога.
const EMBED_BUDGET_BYTES = 4 * 1024
const EMBED_PREFIX = 'embed/'

// Шрифты формы (фаза 22) — ТРЕТИЙ порог, снова отдельный, и снова потому, что
// складывать разное значит не мерить ничего. Шрифт не в бандле: он не парсится и не
// исполняется, приезжает параллельно и только тем респондентам, чьей форме он
// назначен, — но респондент его СКАЧИВАЕТ, и до фазы 22 вес шрифтов в проекте не
// сторожило вообще ничто (check:bundle считал только JS).
//
// Порог — 400 КиБ на всю раздачу: сегодня это шесть вариативных семейств по два
// подмножества (~326 КиБ), запас примерно на одно семейство. Числа сырые, БЕЗ gzip:
// woff2 уже сжат внутри, и gzip поверх него не даёт почти ничего, а сравнивать
// «сжатое сжатое» с тем, что видно в devtools, только путать себя.
//
// ЭТОТ ПОРОГ МЕРИТ ДИСЦИПЛИНУ КАТАЛОГА, А НЕ ВРЕМЯ ЗАГРУЗКИ ФОРМЫ — и потому он
// поднимался (200 → 400, решение владельца 2026-08-15), тогда как бюджет JS не
// поднимают. Респондент качает ОДНО семейство, назначенное его форме: сумма растёт
// от числа вариантов в панели, а не от веса страницы. Что действительно портит
// загрузку — лишние подмножества внутри семейства, и их ловит не сумма, а тест
// состава файлов.
const FONT_BUDGET_BYTES = 400 * 1024

// Считаем весь клиентский JS в dist/: entry и code-split-чанки лежат под assets/
// с хешированными именами (vite-дефолт). Обходим dist/ рекурсивно и берём все .js —
// имена не важны, поэтому переход на хеши сборку не ломает.
const distDir = fileURLToPath(new URL('../dist/', import.meta.url))

// Обход по расширению: тем же кодом собираются и .js под бюджет бандла, и .woff2
// под бюджет шрифтов. Второй параметр остаётся префиксом пути (он идёт в подпись).
function filesUnder(dir, ext, prefix = '') {
  let out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const nested = filesUnder(dir + e.name + '/', ext, prefix + e.name + '/')
      if (nested) out = out.concat(nested)
    } else if (e.name.endsWith(ext)) {
      out.push({ label: prefix + e.name, path: dir + e.name })
    }
  }
  return out
}

const allFiles = filesUnder(distDir, '.js')
const jsFiles = allFiles?.filter((f) => !f.label.startsWith(EMBED_PREFIX)) ?? null
const embedFiles = allFiles?.filter((f) => f.label.startsWith(EMBED_PREFIX)) ?? []
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

// Загрузчик собирается вторым проходом (vite.embed.config.ts). Его отсутствие —
// не ошибка: `vite build` без второго прохода оставляет dist без embed/, и ронять
// на этом проверку формы незачем.
const fontFiles = filesUnder(distDir, '.woff2') ?? []
if (fontFiles.length > 0) {
  let fontTotal = 0
  console.log('')
  for (const f of fontFiles) {
    const size = readFileSync(f.path).length
    fontTotal += size
    console.log(`  ${f.label}  ${kib(size)}`)
  }
  console.log(`Шрифты: ${kib(fontTotal)} · бюджет ${kib(FONT_BUDGET_BYTES)}`)
  if (fontTotal > FONT_BUDGET_BYTES) {
    console.error(
      `✗ бюджет шрифтов превышен на ${kib(fontTotal - FONT_BUDGET_BYTES)}. ` +
        `Убери семейство или подмножество — порог поднимать последним делом.`,
    )
    process.exit(1)
  }
  console.log('✓ шрифты в пределах бюджета')
}

if (embedFiles.length > 0) {
  let embedTotal = 0
  console.log('')
  for (const f of embedFiles) {
    const size = gzipSync(readFileSync(f.path)).length
    embedTotal += size
    console.log(`  ${f.label}  ${kib(size)} gzip`)
  }
  console.log(`Загрузчик embed: ${kib(embedTotal)} gzip · бюджет ${kib(EMBED_BUDGET_BYTES)}`)
  if (embedTotal > EMBED_BUDGET_BYTES) {
    console.error(
      `✗ бюджет загрузчика превышен на ${kib(embedTotal - EMBED_BUDGET_BYTES)}. ` +
        `Он грузится на чужих страницах — режь код, а не порог.`,
    )
    process.exit(1)
  }
  console.log('✓ загрузчик в пределах бюджета')
}
