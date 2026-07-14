import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './index.css'
// Общие стили полей формы (rf-*) — единый источник с кабинетом, см. web/shared/fields/fields.css.
import '@fields/fields.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
