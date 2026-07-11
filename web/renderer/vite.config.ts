import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Публичный рендерер на :5174. Прокси /public на API добавится в фазе 4.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
  },
})
