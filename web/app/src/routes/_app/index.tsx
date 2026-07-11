import { createFileRoute } from '@tanstack/react-router'

// Домашний экран приложения (/). Пока пустой — формы появятся в фазе 2.
export const Route = createFileRoute('/_app/')({
  component: HomePage,
})

function HomePage() {
  return (
    <section className="empty-state">
      <h1>Пока тут пусто</h1>
      <p>Конструктор форм появится в следующих фазах. Сейчас важно, что вы вошли.</p>
    </section>
  )
}
