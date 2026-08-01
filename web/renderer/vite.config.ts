import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// @entities → общий каталог доменных Zod-схем web/shared/entities, единый с
// кабинетом (см. web/shared/entities/formSchema.ts). Лежит вне корня проекта,
// поэтому fs.allow расширяется на родительский web/.
const entities = fileURLToPath(new URL('../shared/entities', import.meta.url))
// @fields → общие компоненты полей; фаза 4 рендерит ими опубликованную форму.
const fields = fileURLToPath(new URL('../shared/fields', import.meta.url))
// preact и zod маппятся абсолютными путями на локальные пакеты: общий код
// (@entities/@fields) лежит вне node_modules рендерера, и его bare-импорты иначе не
// резолвятся при сборке.
const preactPkg = fileURLToPath(new URL('./node_modules/preact', import.meta.url))
const zodPkg = fileURLToPath(new URL('./node_modules/zod', import.meta.url))

// Публичный рендерер на :5174.
// https://vite.dev/config/
export default defineConfig({
  // JSX — автоматический рантайм, задан здесь явно, а не унаследован из tsconfig.
  // Без @vitejs/plugin-react трансформ делает встроенный oxc, и настройку он ищет в
  // ближайшем к файлу tsconfig — а у web/shared/ такого нет (tsconfig.app.json
  // подключает этот каталог через include, но лежит в web/renderer/). Дефолт oxc
  // сейчас и так 'automatic', но полагаться на дефолт чужого трансформера в месте,
  // где ошибка выглядит как «@fields не видят React», не стоит. Источник импорта
  // рантайма остаётся дефолтным ('react/jsx-runtime') — его и уводит алиас ниже.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    // Рендерер работает на Preact: React-API остаётся в исходниках, но рантайм —
    // preact/compat (ARCHITECTURE §«Бандл», ADR). Алиас живёт ТОЛЬКО здесь: те же
    // @fields/@entities кабинет рендерит настоящим React 19, туда preact нельзя.
    // Ключи с подпутями не нужны: алиас @rollup/plugin-alias меняет совпавший
    // префикс и оставляет хвост, поэтому react/jsx-runtime → <preact>/compat/
    // jsx-runtime, react-dom/client → <preact>/compat/client (оба существуют), а
    // 'react-dom' под ключ 'react' не попадает — совпадение только точное либо по
    // границе '/'.
    alias: {
      '@entities': entities,
      '@fields': fields,
      react: preactPkg + '/compat',
      'react-dom': preactPkg + '/compat',
      zod: zodPkg,
    },
  },
  // Имена ассетов — дефолтные хешированные (assets/index-[hash].js/css). HTML-страницу
  // формы /r/{slug} Go отдаёт из собранного index.html, где vite сам проставил эти
  // хеши, — Go ассеты не перечисляет и не знает их имён, поэтому стабильные имена не
  // нужны. Всё уезжает под /assets/* → immutable-кэш Caddy (см. deploy/Caddyfile).
  server: {
    port: 5174,
    // /public проксируется на Go-API (:8080), как /api в кабинете — CORS в dev не
    // нужен, рендерер и API одного origin. HTML-страница /r/{slug} тоже отдаётся
    // API, но в dev её открывает vite (index.html), схему тянем через /public.
    proxy: {
      '/public': 'http://localhost:8080',
      // Картинки блоков — на локальный MinIO (:9000), путь /media/<key> →
      // /<bucket>/<key>. Prod-аналог — Caddy /media (deploy/Caddyfile). Тот же
      // origin, что рендерер → img-src 'self'.
      '/media': {
        target: 'http://127.0.0.1:9000',
        rewrite: (path) => path.replace(/^\/media/, '/app-media'),
      },
    },
    fs: {
      allow: ['..'],
    },
  },
})
