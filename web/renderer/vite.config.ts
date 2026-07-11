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
const reactPkg = fileURLToPath(new URL('./node_modules/react', import.meta.url))

// Публичный рендерер на :5174. Прокси /public на API добавится в фазе 4.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@entities': entities, '@fields': fields, react: reactPkg },
  },
  server: {
    port: 5174,
    fs: {
      allow: ['..'],
    },
  },
})
