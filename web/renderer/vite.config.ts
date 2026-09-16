import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build, defineConfig, type Plugin } from 'vite'

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

// ЗАГРУЗЧИК ВСТРОЕННОЙ ФОРМЫ В DEV. `/embed/v1.js` собирается вторым проходом
// (vite.embed.config.ts) и в dev не существует вовсе: dev-сервер отдаёт `src/`, а не
// `dist/`. До экрана «Встроить» это никого не задевало — вставку смотрели на
// prod-local, — но предпросмотр в кабинете грузит ЭТОТ ЖЕ файл, и без него экран в dev
// показывал бы пустой прямоугольник.
//
// Собираем тем же конфигом, что и прод (формат IIFE, `document.currentScript`), в
// память. Пересборка — по времени правки исходников загрузчика: без кеша каждое
// переключение настройки в панели платило бы полной сборкой.
const embedConfig = fileURLToPath(new URL('./vite.embed.config.ts', import.meta.url))
const embedSources = ['./embed/v1.ts', './embed/api.ts'].map((p) =>
  fileURLToPath(new URL(p, import.meta.url)),
)

function embedLoaderDev(): Plugin {
  let cache: { stamp: number; code: string } | null = null

  const latestChange = async () => {
    const times = await Promise.all(embedSources.map(async (f) => (await stat(f)).mtimeMs))
    return Math.max(...times)
  }

  return {
    name: 'trillix:embed-loader-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/embed/v1.js', (_req, res) => {
        void (async () => {
          const stamp = await latestChange()
          if (cache?.stamp !== stamp) {
            const result = await build({
              configFile: embedConfig,
              logLevel: 'silent',
              build: { write: false },
            })
            const bundles = Array.isArray(result) ? result : [result]
            const chunk = 'output' in bundles[0]! ? bundles[0]!.output[0] : null
            if (chunk === null || chunk.type !== 'chunk') {
              res.statusCode = 500
              res.end('// сборку загрузчика получить не удалось')
              return
            }
            cache = { stamp, code: chunk.code }
          }
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          res.end(cache.code)
        })()
      })
    },
  }
}

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
  plugins: [embedLoaderDev()],
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
  build: {
    // Полифилл modulepreload не подключается: динамический импорт в форме один
    // (пикер времени), и цена полифилла с его рантаймом больше того, что уносит чанк.
    modulePreload: false,
    rollupOptions: {
      output: {
        chunkFileNames: (chunk) => {
          if (chunk.facadeModuleId?.includes('/fields/slots/')) return 'slots/[name]-[hash].js'
          if (chunk.facadeModuleId?.includes('/features/cancel/')) return 'cancel/[name]-[hash].js'
          if (chunk.facadeModuleId?.includes('/features/document/')) return 'document/[name]-[hash].js'
          return 'assets/[name]-[hash].js'
        },
        assetFileNames: (asset) => {
          if (asset.names?.some((n) => n.startsWith('SlotPicker'))) return 'slots/[name]-[hash][extname]'
          if (asset.names?.some((n) => n.startsWith('CancelScreen'))) return 'cancel/[name]-[hash][extname]'
          if (asset.names?.some((n) => n.startsWith('DocumentScreen'))) return 'document/[name]-[hash][extname]'
          return 'assets/[name]-[hash][extname]'
        },
      },
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
