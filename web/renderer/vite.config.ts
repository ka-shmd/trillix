import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// @entities → общий каталог доменных Zod-схем web/shared/entities, единый с
// кабинетом (см. web/shared/entities/formSchema.ts). Лежит вне корня проекта,
// поэтому fs.allow расширяется на родительский web/.
const entities = fileURLToPath(new URL('../shared/entities', import.meta.url))

// Публичный рендерер на :5174. Прокси /public на API добавится в фазе 4.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@entities': entities },
  },
  server: {
    port: 5174,
    fs: {
      allow: ['..'],
    },
  },
})
