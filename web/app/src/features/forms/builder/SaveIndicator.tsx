import { type SaveStatus } from './useAutosave'

// Индикатор автосейва в шапке билдера. Конфликт показывает нейтральную строку —
// подробности и действие несёт ConflictBanner.
export function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  switch (status) {
    case 'saving':
      return (
        <span className="save-status" role="status">
          Сохранение…
        </span>
      )
    case 'saved':
      return (
        <span className="save-status save-status-ok" role="status">
          Все изменения сохранены
        </span>
      )
    case 'error':
      return (
        <span className="save-status save-status-error" role="status">
          Не удалось сохранить —{' '}
          <button type="button" className="save-retry" onClick={onRetry}>
            Повторить
          </button>
        </span>
      )
    case 'conflict':
      return <span className="save-status save-status-error">Сохранение приостановлено</span>
  }
}

// ConflictBanner — форму изменили в другой вкладке (409). Оптимистичная блокировка
// в MVP разрешается перезагрузкой: перечитать серверную версию и продолжить с неё.
export function ConflictBanner() {
  return (
    <div className="builder-conflict" role="alert">
      <span>Форма изменена в другой вкладке. Обновите страницу, чтобы продолжить редактирование.</span>
      <button type="button" onClick={() => window.location.reload()}>
        Обновить
      </button>
    </div>
  )
}
