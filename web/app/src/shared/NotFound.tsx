import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'

// Дружелюбный 404 кабинета: неизвестный URL вместо служебного текста роутера.
// Полностраничный (вне оболочки _app) — путь может быть и без сессии.
export function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="max-w-md text-center">
        <p className="text-6xl font-semibold tracking-tight text-muted-foreground">404</p>
        <h1 className="mt-4 text-lg font-medium">Страница не найдена</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ссылка неверна или страница была удалена.
        </p>
        <Button asChild className="mt-6">
          <Link to="/forms">К формам</Link>
        </Button>
      </div>
    </main>
  )
}
