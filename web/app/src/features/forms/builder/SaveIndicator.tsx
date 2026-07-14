import { type SaveStatus } from './useAutosave'

// Индикатор автосейва в шапке билдера. Конфликт показывает нейтральную строку —
// подробности и действие несёт ConflictBanner.
export function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  switch (status) {
    case 'saving':
      return (
        <span className="text-sm text-muted-foreground" role="status">
          Сохранение…
        </span>
      )
    case 'saved':
      return (
        <span className="text-sm text-muted-foreground" role="status">
          Все изменения сохранены
        </span>
      )
    case 'error':
      return (
        <span className="text-sm text-destructive" role="status">
          Не удалось сохранить —{' '}
          <button type="button" className="underline underline-offset-2" onClick={onRetry}>
            Повторить
          </button>
        </span>
      )
    case 'conflict':
      return <span className="text-sm text-destructive">Сохранение приостановлено</span>
  }
}

// ConflictBanner — форму изменили в другой вкладке (409). Оптимистичная блокировка
// в MVP разрешается перезагрузкой: перечитать серверную версию и продолжить с неё.
export function ConflictBanner() {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-sm"
      role="alert"
    >
      <span>Форма изменена в другой вкладке. Обновите страницу, чтобы продолжить редактирование.</span>
      <button
        type="button"
        className="font-medium text-destructive underline underline-offset-2"
        onClick={() => window.location.reload()}
      >
        Обновить
      </button>
    </div>
  )
}
