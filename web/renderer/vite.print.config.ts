import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Сборка ПЕЧАТНОЙ СТРАНИЦЫ ответа (dist/print/, ADR §10) — отдельная от сборки
// формы, и по тем же основаниям, по каким отдельно собирается загрузчик embed:
//
//   - у неё ДРУГОЙ читатель. Форму качает респондент с телефона, печатную страницу
//     открывает наш же принтер по внутренней сети. Класть её код в бандл формы
//     значило бы отдать респонденту то, что ему никогда не понадобится, и съесть
//     бюджет 45 КиБ чужим весом;
//   - её ассеты живут под /print/, поэтому base свой: HTML отдаёт Go, а файлы рядом
//     с ним раздаёт он же из смонтированного каталога статики.
//
// Шрифты и стили формы приезжают сюда СВОИМИ копиями (общего чанка у раздельных
// сборок нет) — это осознанная цена раздельности, и она оплачена диском образа, а не
// трафиком респондента: check-bundle.mjs считает print/ отдельно от формы.
//
// emptyOutDir: false — конфиг запускается ПОСЛЕ основной сборки и не должен вынести
// её результат из dist/.
const entities = fileURLToPath(new URL('../shared/entities', import.meta.url))
const fields = fileURLToPath(new URL('../shared/fields', import.meta.url))
const preactPkg = fileURLToPath(new URL('./node_modules/preact', import.meta.url))
const zodPkg = fileURLToPath(new URL('./node_modules/zod', import.meta.url))

export default defineConfig({
  base: '/internal/print/',
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    // Тот же preact/compat, что у формы: страница печати рисуется теми же @fields, и
    // тянуть ради неё второй рантайм незачем.
    alias: {
      '@entities': entities,
      '@fields': fields,
      react: preactPkg + '/compat',
      'react-dom': preactPkg + '/compat',
      zod: zodPkg,
    },
  },
  build: {
    outDir: 'dist/print',
    emptyOutDir: false,
    rollupOptions: { input: 'print.html' },
  },
})
