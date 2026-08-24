import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Pencil, Table2, Trash2 } from 'lucide-react'

import type { FormIntegrations, FormSheet } from '../../entities/integration'
import { GoogleSheetsOverlay } from './GoogleSheetsOverlay'
import { formIntegrationsQueryOptions, useUnlinkSheet, useUpdateConnection } from './queries'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

// Экран «Интеграции» формы — два блока, как у образца (Tally): сверху то, что уже
// работает, снизу то, что можно подключить.
//
// Разделение не косметическое. Верхний блок отвечает на «куда сейчас уезжают мои
// ответы» — это состояние, за которым следят; нижний на «что ещё можно» — это
// каталог, который со временем станет длинным. Смешать их значит спрятать первое
// внутри второго ровно тогда, когда интеграций станет много.
//
// Настройки любой связки живут в полноэкранном оверлее: у интеграции есть
// решения, которые принимают ДО первой записи в чужие данные, и в списке они
// превратились бы в цепочку кнопок, каждая из которых уже что-то поменяла.
export function IntegrationsView({ formId }: { formId: string }) {
  const state = useQuery(formIntegrationsQueryOptions(formId))
  // overlay — что открыто: 'new' (подключаем ещё одну) либо id связки (правим).
  const [overlay, setOverlay] = useState<string | null>(null)

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

  const { connections } = state.data
  const editing = connections.find((c) => c.id === overlay) ?? null

  return (
    <section className="flex flex-col gap-10">
      {connections.length > 0 && (
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="font-medium">Мои подключения</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Куда уезжают ответы этой формы. Подключений может быть несколько — например, в
              рабочую таблицу и в архивную.
            </p>
          </div>
          <ul className="flex flex-col gap-2">
            {connections.map((connection) => (
              <li key={connection.id}>
                <ConnectionRow
                  formId={formId}
                  connection={connection}
                  accountLost={state.data.account.needsReconnect}
                  onEdit={() => setOverlay(connection.id)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div>
          <h2 className="font-medium">Доступные интеграции</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Ответы формы могут уезжать во внешние сервисы сами — сразу после отправки.
          </p>
        </div>
        {/* Один живой пункт. Заглушек «скоро будет» здесь нет: они обещают срок,
            которого никто не давал. */}
        <div className="flex items-center gap-3 rounded-lg border p-4">
          <Table2 className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Google Таблицы</p>
            <p className="text-sm text-muted-foreground">{catalogSummary(state.data)}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setOverlay('new')}>
            Подключить
          </Button>
        </div>
      </div>

      {overlay && (
        <GoogleSheetsOverlay
          formId={formId}
          state={state.data}
          connection={editing}
          onClose={() => setOverlay(null)}
        />
      )}
    </section>
  )
}

// ConnectionRow — одна работающая связка: состояние слева, управление справа.
function ConnectionRow({
  formId,
  connection,
  accountLost,
  onEdit,
}: {
  formId: string
  connection: FormSheet
  // accountLost — аккаунт пространства требует переподключения. Состояние
  // связки при этом всё ещё live: доставка узнает о беде, только когда придёт
  // ответ. Строка обязана сказать правду раньше — иначе человек видит зелёное
  // «синхронизируются» ровно до первого потерянного ответа.
  accountLost: boolean
  onEdit: () => void
}) {
  const update = useUpdateConnection(formId)
  const unlink = useUnlinkSheet(formId)
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="flex items-center gap-3 rounded-lg border p-4">
      <Table2 className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-medium">
          {connection.name || 'Google Таблицы'}
          <StatusDot
            status={connection.status}
            enabled={connection.enabled}
            accountLost={accountLost}
          />
        </p>
        <p className="text-sm text-muted-foreground">
          {connectionSummary(connection, accountLost)}{' '}
          <a
            href={connection.url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            таблицей
          </a>
        </p>
      </div>

      <Switch
        checked={connection.enabled}
        disabled={update.isPending}
        aria-label={connection.enabled ? 'Выключить подключение' : 'Включить подключение'}
        onCheckedChange={(enabled) =>
          update.mutate({ id: connection.id, name: connection.name ?? '', enabled })
        }
      />
      <Button variant="ghost" size="icon" aria-label="Настроить подключение" onClick={onEdit}>
        <Pencil className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Удалить подключение"
        onClick={() => setConfirming(true)}
      >
        <Trash2 className="size-4" />
      </Button>

      {/* Удаление спрашивает: связка уносит с собой настройки и историю
          доставок, а восстановить её можно только подключением заново. Сама
          таблица при этом остаётся — об этом здесь и сказано, чтобы человек не
          боялся потерять данные. */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить подключение?</AlertDialogTitle>
            <AlertDialogDescription>
              Новые ответы перестанут уезжать в эту таблицу. Сама таблица и всё, что уже в неё
              попало, останутся на вашем Google Диске.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => unlink.mutate(connection.id)}>
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// StatusDot — точка состояния: зелёная у работающей связки, серая у выключенной,
// красная у сломанной. Точка, а не текст: в строке списка важен факт «в порядке
// или нет», а подробности живут в настройках.
function StatusDot({
  status,
  enabled,
  accountLost,
}: {
  status: FormSheet['status']
  enabled: boolean
  accountLost: boolean
}) {
  const [color, label] = !enabled
    ? ['bg-muted-foreground/50', 'Выключено']
    : status === 'broken' || accountLost
      ? ['bg-destructive', 'Сломано']
      : status === 'backfilling'
        ? ['bg-amber-500', 'Переносим ответы']
        : ['bg-emerald-500', 'Работает']

  return <span className={`size-2 rounded-full ${color}`} role="img" aria-label={label} />
}

function connectionSummary(connection: FormSheet, accountLost: boolean): string {
  if (!connection.enabled) return 'Выключено. Ответы не синхронизируются с'
  // Потерянный аккаунт важнее статуса связки: чинится он, а не она.
  if (accountLost) return 'Доступ к Google потерян — подключите аккаунт заново; связано с'
  if (connection.status === 'broken') return 'Записать не удаётся — откройте настройки; связано с'
  if (connection.status === 'backfilling') return 'Переносим накопленные ответы в'
  return 'Ответы синхронизируются с'
}

// catalogSummary — строка каталога. Она же объясняет, почему кнопка «Подключить»
// может не сработать: аккаунта ещё нет или интеграция не настроена на контуре.
function catalogSummary(state: FormIntegrations): string {
  if (!state.account.enabled) return 'На этом контуре интеграция не настроена'
  if (state.account.needsReconnect) {
    return `Доступ к аккаунту ${state.account.email} потерян — подключите его заново`
  }
  if (state.account.connected) return `Подключено как ${state.account.email}`
  return 'Каждый ответ ложится строкой в таблицу на вашем Google Диске'
}
