import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Кабинет на :5173. Прокси /api на Go-сервер :8080 убирает необходимость в CORS в dev.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
})
