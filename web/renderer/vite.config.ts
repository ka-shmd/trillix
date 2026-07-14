import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// @entities → общий каталог доменных Zod-схем web/shared/entities, единый с
// кабинетом (см. web/shared/entities/formSchema.ts). Лежит вне корня проекта,
// поэтому fs.allow расширяется на родительский web/.
const entities = fileURLToPath(new URL('../shared/entities', import.meta.url))
// @fields → общие компоненты полей; фаза 4 рендерит ими опубликованную форму.
// react маппится на локальный пакет: общий код лежит вне node_modules рендерера.
const fields = fileURLToPath(new URL('../shared/fields', import.meta.url))
// react и zod маппятся на локальный пакет: общий код (@entities/@fields) лежит вне
// node_modules рендерера, и его bare-импорты иначе не резолвятся при сборке.
const reactPkg = fileURLToPath(new URL('./node_modules/react', import.meta.url))
const zodPkg = fileURLToPath(new URL('./node_modules/zod', import.meta.url))

// Публичный рендерер на :5174. Прокси /public на API добавится в фазе 4.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@entities': entities, '@fields': fields, react: reactPkg, zod: zodPkg },
  },
  build: {
    rollupOptions: {
      output: {
        // Entry со стабильным именем: HTML-страницу формы /r/{slug} отдаёт Go, и
        // он должен ссылаться на скрипт по фиксированному пути (PUBLIC_RENDERER_
        // SCRIPT_PATH=/renderer.js), не зная хеша сборки. Чанки и ассеты остаются
        // хешированными под /assets/* (immutable-кэш Caddy); ревалидируется только
        // маленький entry.
        entryFileNames: 'renderer.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5174,
    // /public проксируется на Go-API (:8080), как /api в кабинете — CORS в dev не
    // нужен, рендерер и API одного origin. HTML-страница /r/{slug} тоже отдаётся
    // API, но в dev её открывает vite (index.html), схему тянем через /public.
    proxy: {
      '/public': 'http://localhost:8080',
    },
    fs: {
      allow: ['..'],
    },
  },
})
