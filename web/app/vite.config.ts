import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

// @entities → общий каталог доменных Zod-схем web/shared/entities, единый для
// кабинета и рендерера (см. web/shared/entities/formSchema.ts). Лежит вне корня
// проекта, поэтому fs.allow расширяется на родительский web/.
const entities = fileURLToPath(new URL('../shared/entities', import.meta.url))
// @fields → общие компоненты полей (превью билдера и рендерер фазы 4).
const fields = fileURLToPath(new URL('../shared/fields', import.meta.url))
// web/shared не имеет своего node_modules, поэтому bare-импорты zod/react из
// общего кода не резолвятся при сборке (Rolldown ищет относительно импортёра).
// Маппим их на локальные пакеты кабинета — зеркало tsconfig.app.json paths.
const zod = fileURLToPath(new URL('./node_modules/zod', import.meta.url))
const reactPkg = fileURLToPath(new URL('./node_modules/react', import.meta.url))
// @ → src кабинета: путь shadcn-компонентов (@/components/ui, @/lib/utils).
const src = fileURLToPath(new URL('./src', import.meta.url))

// Кабинет на :5173. Прокси /api на Go-сервер :8080 убирает необходимость в CORS в dev.
// https://vite.dev/config/
export default defineConfig({
  // Роутер-плагин генерирует src/routeTree.gen.ts из файловых маршрутов; должен
  // стоять перед react(). Файл коммитится и обновляется на каждом dev/build.
  plugins: [tanstackRouter({ target: 'react' }), react(), tailwindcss()],
  resolve: {
    alias: { '@entities': entities, '@fields': fields, '@': src, zod, react: reactPkg },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      // Картинки блоков — на локальный MinIO (:9000), путь /media/<key> →
      // /<bucket>/<key>. Prod-аналог — Caddy /media (deploy/Caddyfile). Бакет dev —
      // app-media (.env.dev); тот же origin, что кабинет → img-src 'self'.
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
