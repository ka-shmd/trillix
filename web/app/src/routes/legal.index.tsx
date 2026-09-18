import { createFileRoute } from '@tanstack/react-router'
import { LegalIndexPage } from '../features/legal/LegalPages'

// Правовая информация сервиса — без входа (docs/design/signup-consent.md §3.7). Вне _app
// и _auth: первый увёл бы гостя на вход, второй — вошедшего в кабинет.
export const Route = createFileRoute('/legal/')({
  component: LegalIndexPage,
})
