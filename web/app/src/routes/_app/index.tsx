import { createFileRoute, redirect } from '@tanstack/react-router'

// Домашний экран приложения (/) — редирект на дашборд форм: он и есть главная.
export const Route = createFileRoute('/_app/')({
  beforeLoad: () => {
    throw redirect({ to: '/forms' })
  },
})
