import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

// Кабинет на :5173. Прокси /api на Go-сервер :8080 убирает необходимость в CORS в dev.
// https://vite.dev/config/
export default defineConfig({
  // Роутер-плагин генерирует src/routeTree.gen.ts из файловых маршрутов; должен
  // стоять перед react(). Файл коммитится и обновляется на каждом dev/build.
  plugins: [tanstackRouter({ target: 'react' }), react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
})
