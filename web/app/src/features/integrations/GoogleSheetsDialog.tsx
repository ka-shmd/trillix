import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, Unlink } from 'lucide-react'

import type { FormIntegrations } from '../../entities/integration'
import { useOAuthPopup, type OAuthOutcome } from '../../shared/oauthPopup'
import { startUrl } from './api'
import {
  spreadsheetsQueryOptions,
  useCreateSheet,
  useDisconnectAccount,
  useRefillSheet,
  useUnlinkSheet,
} from './queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

// Окно настройки интеграции — общий жест продукта: клик по интеграции открывает
// её настройки, и только кнопка внизу что-то меняет.
//
// Почему окно, а не поля прямо в списке: у интеграции есть решения, которые
// принимают ДО первой записи в чужие данные (какой аккаунт, какая таблица,
// заливать ли историю). В списке они превратились бы в цепочку мелких кнопок,
// каждая из которых уже что-то поменяла, а сам список — в простыню настроек,
// где непонятно, что к чему относится. Отмена здесь — Escape, и не произошло
// ничего.
//
// NEW_SPREADSHEET — «завести новую книгу». Значение непустое, потому что пустая
// строка у Select значит «ничего не выбрано» и роняет плейсхолдер.
const NEW_SPREADSHEET = '__new__'

export function GoogleSheetsDialog({
  formId,
  state,
  onOpenChange,
}: {
  formId: string
  state: FormIntegrations
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Google Таблицы</DialogTitle>
          <DialogDescription>
            Ответы этой формы будут ложиться строками в таблицу на вашем Google Диске.
          </DialogDescription>
        </DialogHeader>

        {state.sheet ? (
          <ConnectedBody formId={formId} state={state} onDone={() => onOpenChange(false)} />
        ) : (
          <SetupBody formId={formId} state={state} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

// SetupBody — форма подключения: те решения, которые принимаются до первой
// записи в чужие данные.
function SetupBody({
  formId,
  state,
  onDone,
}: {
  formId: string
  state: FormIntegrations
  onDone: () => void
}) {
  const { account, workspaceId } = state
  const [name, setName] = useState('')
  const [spreadsheet, setSpreadsheet] = useState(NEW_SPREADSHEET)
  const [backfill, setBackfill] = useState(true)
  const create = useCreateSheet(formId)

  // Список таблиц имеет смысл только у подключённого аккаунта: это поход к
  // провайдеру его токеном.
  const sheets = useQuery({ ...spreadsheetsQueryOptions(formId), enabled: account.connected })

  if (!account.enabled) {
    return (
      <p className="text-sm text-muted-foreground">
        На этом контуре интеграция не настроена — обратитесь к администратору.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="integration-name">Название подключения</Label>
        <Input
          id="integration-name"
          value={name}
          maxLength={80}
          placeholder="Необязательно — чтобы отличать связки друг от друга"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <AccountField workspaceId={workspaceId} account={account} />

      <div className="flex flex-col gap-2">
        <Label htmlFor="integration-spreadsheet">Таблица</Label>
        <Select
          value={spreadsheet}
          onValueChange={setSpreadsheet}
          disabled={!account.connected}
        >
          <SelectTrigger id="integration-spreadsheet">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEW_SPREADSHEET}>Создать новую таблицу</SelectItem>
            {(sheets.data ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          В списке — только таблицы, созданные Trillix: доступа к остальным файлам Диска у нас
          нет. У выбранной книги появится отдельный лист для этой формы.
        </p>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="integration-backfill">Перенести уже накопленные ответы</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            Ответы, которые форма собрала раньше, уедут в таблицу сразу. У формы с тысячами
            ответов перенос займёт время.
          </p>
        </div>
        <Switch
          id="integration-backfill"
          checked={backfill}
          onCheckedChange={setBackfill}
          disabled={!account.connected}
        />
      </div>

      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          Не удалось подключить таблицу. Попробуйте ещё раз.
        </p>
      )}

      <DialogFooter>
        <Button
          disabled={!account.connected || create.isPending}
          onClick={() =>
            create.mutate(
              {
                name,
                spreadsheetId: spreadsheet === NEW_SPREADSHEET ? '' : spreadsheet,
                backfill,
              },
              { onSuccess: onDone },
            )
          }
        >
          Подключить Google Таблицы
        </Button>
      </DialogFooter>
    </div>
  )
}

// AccountField — аккаунт, от имени которого пишем. Подключение живёт у
// ПРОСТРАНСТВА, а не у формы, поэтому здесь оно показывается, а не выбирается:
// второй аккаунт — отдельная работа (спека §2).
function AccountField({
  workspaceId,
  account,
}: {
  workspaceId: string
  account: FormIntegrations['account']
}) {
  const [outcome, setOutcome] = useState<OAuthOutcome | null>(null)
  const popup = useOAuthPopup((result) => {
    setOutcome(result === 'integration_ok' ? null : result)
  })

  return (
    <div className="flex flex-col gap-2">
      <Label>Аккаунт Google</Label>
      {account.connected ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
          <span className="text-sm">{account.email}</span>
          {account.canManage && (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="ml-auto h-7 text-xs"
              title="Заменит подключение пространства: таблицы, созданные прежним аккаунтом, перестанут наполняться"
            >
              <a
                href={startUrl(workspaceId)}
                onClick={(e) => {
                  if (popup.open(startUrl(workspaceId))) e.preventDefault()
                }}
              >
                Сменить аккаунт
              </a>
            </Button>
          )}
        </div>
      ) : account.canManage ? (
        <>
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
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Подключить Google может владелец пространства.
        </p>
      )}

      {popup.waiting && <WaitingNote onCancel={popup.cancel} />}
      {outcome && (
        <p role="status" className="text-sm text-destructive">
          {connectFailureText(outcome)}
        </p>
      )}
    </div>
  )
}

// ConnectedBody — форма уже привязана: окно показывает состояние и действия.
function ConnectedBody({
  formId,
  state,
  onDone,
}: {
  formId: string
  state: FormIntegrations
  onDone: () => void
}) {
  const { account, sheet, workspaceId } = state
  const refill = useRefillSheet(formId)
  const unlink = useUnlinkSheet(formId)
  const disconnect = useDisconnectAccount(workspaceId)
  if (!sheet) return null

  return (
    <div className="flex flex-col gap-4">
      {sheet.name && <p className="text-sm">{sheet.name}</p>}
      <p className="text-sm text-muted-foreground">
        Подключено как <span className="text-foreground">{account.email}</span>
      </p>

      {sheet.status === 'broken' ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          {sheet.lastError || 'Записать в таблицу не удаётся. Переподключите аккаунт.'}
        </p>
      ) : sheet.status === 'backfilling' ? (
        <p className="text-sm text-muted-foreground">
          Переносим ответы, которые уже пришли. Новые встанут в очередь и попадут в таблицу следом.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          {sheet.lastDeliveredAt
            ? `Последний ответ уехал в таблицу ${formatMoment(sheet.lastDeliveredAt)}.`
            : 'Ответы будут попадать в таблицу сразу после отправки.'}
        </p>
      )}

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
          onClick={() => unlink.mutate(undefined, { onSuccess: onDone })}
        >
          <Unlink className="size-4" /> Отвязать форму
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Отвязка не удаляет таблицу: строки, которые уже уехали, останутся на вашем Диске.
      </p>

      {account.canManage && (
        <div className="border-t pt-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate(undefined, { onSuccess: onDone })}
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

// WaitingNote — ожидание согласия. Не второе модальное окно поверх первого:
// диалог в диалоге Radix уводит фокус и оставляет человека в ловушке из двух
// оверлеев, а окно провайдера и так сверху.
function WaitingNote({ onCancel }: { onCancel: () => void }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      Ждём подтверждения в окне Google…
      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onCancel}>
        Отменить
      </Button>
    </p>
  )
}

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

// formatMoment — «23 августа, 14:05» человеку понятнее ISO-строки, а точность до
// минуты здесь всё, что нужно.
function formatMoment(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'недавно'
  return at.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
}
