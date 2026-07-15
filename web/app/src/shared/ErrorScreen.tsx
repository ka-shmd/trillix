import { Link, type ErrorComponentProps } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'

// Дружелюбный error-boundary кабинета: краш лоадера/рендера маршрута вместо
// служебного текста роутера. Полностраничный (может сработать вне оболочки _app).
// reset перезапускает упавший маршрут — «Повторить» без перезагрузки страницы.
export function ErrorScreen({ reset }: ErrorComponentProps) {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-medium">Что-то пошло не так</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Не удалось показать страницу. Попробуйте ещё раз.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={reset}>Повторить</Button>
          <Button asChild variant="outline">
            <Link to="/forms">К формам</Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
