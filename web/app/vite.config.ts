import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

// @entities → общий каталог доменных Zod-схем web/shared/entities, единый для
// кабинета и рендерера (см. web/shared/entities/formSchema.ts). Лежит вне корня
// проекта, поэтому fs.allow расширяется на родительский web/.
const entities = fileURLToPath(new URL('../shared/entities', import.meta.url))

// Кабинет на :5173. Прокси /api на Go-сервер :8080 убирает необходимость в CORS в dev.
// https://vite.dev/config/
export default defineConfig({
  // Роутер-плагин генерирует src/routeTree.gen.ts из файловых маршрутов; должен
  // стоять перед react(). Файл коммитится и обновляется на каждом dev/build.
  plugins: [tanstackRouter({ target: 'react' }), react()],
  resolve: {
    alias: { '@entities': entities },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
    fs: {
      allow: ['..'],
    },
  },
})
