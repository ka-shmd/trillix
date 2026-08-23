import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, Table2, Unlink } from 'lucide-react'

import { type FormIntegrations, type FormSheet } from '../../entities/integration'
import { useOAuthPopup, type OAuthOutcome } from '../../shared/oauthPopup'
import { startUrl } from './api'
import {
  formIntegrationsQueryOptions,
  useCreateSheet,
  useDisconnectAccount,
  useRefillSheet,
  useUnlinkSheet,
} from './queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Экран «Интеграции» формы. Один живой пункт — Google Таблицы. Заглушек «скоро
// будет» здесь нет: они обещают срок, которого никто не давал.
export function IntegrationsView({ formId }: { formId: string }) {
  const state = useQuery(formIntegrationsQueryOptions(formId))

  if (state.isPending) {
    return <p className="text-sm text-muted-foreground">Загрузка…</p>
  }
  if (state.isError || !state.data) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <p className="mb-3 text-sm">Не удалось загрузить интеграции.</p>
        <Button variant="outline" size="sm" onClick={() => state.refetch()}>
          Повторить
        </Button>
      </div>
    )
  }

  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Ответы этой формы могут уезжать во внешние сервисы сами — сразу после отправки.
      </p>
      <GoogleSheetsCard formId={formId} state={state.data} />
    </section>
  )
}

function GoogleSheetsCard({ formId, state }: { formId: string; state: FormIntegrations }) {
  const { account, sheet, workspaceId } = state

  return (
    <article className="rounded-lg border p-4">
      <header className="flex items-start gap-3">
        <Table2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">Google Таблицы</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Каждый ответ ложится строкой в таблицу на вашем Google Диске.
          </p>
        </div>
        {sheet && <StatusBadge status={sheet.status} />}
      </header>

      <div className="mt-4">
        {!account.enabled ? (
          <p className="text-sm text-muted-foreground">
            На этом контуре интеграция не настроена — обратитесь к администратору.
          </p>
        ) : !account.connected ? (
          <ConnectAccount workspaceId={workspaceId} canManage={account.canManage} />
        ) : (
          <SheetSection formId={formId} state={state} />
        )}
      </div>
    </article>
  )
}

// ConnectAccount — подключение аккаунта Google к пространству. Право спрашивает
// сервер и отдаёт готовым флагом: матрица прав живёт на бэке, и дублировать её
// в TypeScript нельзя (web/CLAUDE.md).
function ConnectAccount({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const [outcome, setOutcome] = useState<OAuthOutcome | null>(null)
  const popup = useOAuthPopup((result) => {
    // Успех не нуждается в подписи: экран перерисуется сам по инвалидации
    // (окно вернулось — состояние перезапрошено).
    setOutcome(result === 'integration_ok' ? null : result)
  })

  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        Подключить Google может владелец пространства.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {popup.waiting && <WaitingDialog onCancel={popup.cancel} />}
      {outcome && (
        <p role="status" className="text-sm text-destructive">
          {connectFailureText(outcome)}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Мы попросим доступ только к таблицам, которые создадим сами, — остальные файлы Диска
        останутся закрытыми. Ответы, включая персональные данные респондентов, будут
        передаваться в сервис Google.
      </p>
      {/* Именно <a>, а не onClick+fetch: нужен полноценный переход браузера —
          XHR за редиректом на домен Google не пойдёт. Клик пробует открыть
          отдельное окно и гасит переход, только если это удалось. */}
      <Button asChild className="self-start">
        <a
          href={startUrl(workspaceId)}
          onClick={(e) => {
            setOutcome(null)
            if (popup.open(startUrl(workspaceId))) e.preventDefault()
          }}
        >
          Подключить Google
        </a>
      </Button>
    </div>
  )
}

function SheetSection({ formId, state }: { formId: string; state: FormIntegrations }) {
  const { account, sheet, workspaceId } = state
  const create = useCreateSheet(formId)
  const refill = useRefillSheet(formId)
  const unlink = useUnlinkSheet(formId)
  const disconnect = useDisconnectAccount(workspaceId)

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Подключено как <span className="text-foreground">{account.email}</span>
      </p>

      {sheet ? (
        <>
          <SheetState sheet={sheet} />
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <a href={sheet.url} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" /> Открыть таблицу
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={refill.isPending || sheet.status === 'backfilling'}
              onClick={() => refill.mutate()}
            >
              <RefreshCw className="size-4" /> Перезалить всё
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              disabled={unlink.isPending}
              onClick={() => unlink.mutate()}
            >
              <Unlink className="size-4" /> Отвязать форму
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Отвязка не удаляет таблицу: строки, которые уже уехали, останутся на вашем Диске.
          </p>
        </>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
            Создать таблицу для этой формы
          </Button>
          <p className="text-xs text-muted-foreground">
            Мы заведём новую таблицу на вашем Диске и перенесём в неё ответы, которые уже пришли.
          </p>
        </div>
      )}

      {account.canManage && (
        <div className="border-t pt-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            Отключить Google от пространства
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            Отключение снимет привязки всех форм пространства.
          </p>
        </div>
      )}
    </div>
  )
}

function SheetState({ sheet }: { sheet: FormSheet }) {
  if (sheet.status === 'broken') {
    return (
      <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
        {sheet.lastError || 'Записать в таблицу не удаётся. Переподключите аккаунт.'}
      </p>
    )
  }
  if (sheet.status === 'backfilling') {
    return (
      <p className="text-sm text-muted-foreground">
        Переносим ответы, которые уже пришли. Новые встанут в очередь и попадут в таблицу следом.
      </p>
    )
  }
  return (
    <p className="text-sm text-muted-foreground">
      {sheet.lastDeliveredAt
        ? `Последний ответ уехал в таблицу ${formatMoment(sheet.lastDeliveredAt)}.`
        : 'Ответы будут попадать в таблицу сразу после отправки.'}
    </p>
  )
}

function StatusBadge({ status }: { status: FormSheet['status'] }) {
  if (status === 'broken') return <Badge variant="destructive">Сломана</Badge>
  if (status === 'backfilling') return <Badge variant="secondary">Переносим</Badge>
  return <Badge variant="outline">Работает</Badge>
}

// WaitingDialog — своё ожидание, а не общее с экраном входа: там текст про вход
// в аккаунт, здесь — про доступ к Диску, и подменять одно другим значит врать
// человеку в самый ответственный момент.
function WaitingDialog({ onCancel }: { onCancel: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ждём подтверждения в окне Google</DialogTitle>
          <DialogDescription>
            Выберите аккаунт и разрешите доступ в открывшемся окне — оно закроется само. Эту
            вкладку не закрывайте: продолжение будет здесь.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Отменить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// connectFailureText — что показать, когда окно вернулось без подключения.
// Отказ человека («передумал») тоже сюда не попадает молча: он видит, почему
// ничего не изменилось.
function connectFailureText(outcome: OAuthOutcome): string {
  switch (outcome) {
    case 'integration_denied':
      return 'Доступ к Google Диску не выдан — без него таблицу создать нечем.'
    case 'integration_forbidden':
      return 'Подключить Google может только владелец пространства.'
    case 'integration_expired':
      return 'Подключение заняло слишком много времени. Попробуйте ещё раз.'
    default:
      return 'Не удалось подключить Google. Попробуйте ещё раз.'
  }
}

// formatMoment — «сегодня в 14:05» человеку понятнее ISO-строки, а точность до
// минуты здесь всё, что нужно.
function formatMoment(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'недавно'
  return at.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
}
