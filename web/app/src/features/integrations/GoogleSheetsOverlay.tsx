import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, Table2, Unlink } from 'lucide-react'

import type { FormIntegrations, SpreadsheetRef } from '../../entities/integration'
import { useOAuthPopup, type OAuthOutcome } from '../../shared/oauthPopup'
import { getPickerCredentials, startUrl } from './api'
import { pickSpreadsheet } from './picker'
import {
  spreadsheetsQueryOptions,
  useCreateSheet,
  useDisconnectAccount,
  useRefillSheet,
  useUnlinkSheet,
} from './queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
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

// Настройка интеграции — оверлей во весь экран, а не поля в списке и не карточка
// посреди страницы.
//
// Почему во весь экран: у интеграции есть решения, которые принимают ДО первой
// записи в чужие данные (какой аккаунт, какая таблица, заливать ли историю). В
// списке они превратились бы в цепочку мелких кнопок, каждая из которых уже
// что-то поменяла, а сам список — в простыню настроек. Полноэкранный слой
// убирает всё лишнее: пока настраиваешь, ничего другого на экране нет.
//
// Внутри — Radix Dialog, растянутый на вьюпорт: от него нужны ловушка фокуса,
// Escape и блокировка прокрутки под слоем. Свой `fixed inset-0` дал бы вид, но
// не дал бы ни одного из трёх, и клавиатура ушла бы гулять по списку под
// оверлеем.
//
// NEW_SPREADSHEET — «завести новую книгу». Значение непустое, потому что пустая
// строка у Select значит «ничего не выбрано» и роняет плейсхолдер.
const NEW_SPREADSHEET = '__new__'

export function GoogleSheetsOverlay({
  formId,
  state,
  onClose,
}: {
  formId: string
  state: FormIntegrations
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-svh max-h-svh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none border-none p-0 sm:max-w-none"
        style={{ top: 0, left: 0 }}
      >
        <div className="mx-auto flex w-full max-w-lg flex-col gap-8 px-6 py-16">
          <header className="flex flex-col items-center gap-3 text-center">
            <Table2 className="size-8 text-muted-foreground" aria-hidden />
            <DialogTitle className="text-2xl">Google Таблицы</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Ответы этой формы будут ложиться строками в таблицу на вашем Google Диске.
            </p>
          </header>

          {state.sheet ? (
            <ConnectedBody formId={formId} state={state} onDone={onClose} />
          ) : (
            <SetupBody formId={formId} state={state} onDone={onClose} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// SetupBody — путь подключения. До подключённого аккаунта настраивать нечего:
// показываем только рассказ и кнопку согласия. Поля, которые всё равно
// заперты, — это обещание работы, которой человек ещё не может сделать.
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
      <p className="text-center text-sm text-muted-foreground">
        На этом контуре интеграция не настроена — обратитесь к администратору.
      </p>
    )
  }

  if (!account.connected) {
    return <ConnectAccount workspaceId={workspaceId} canManage={account.canManage} />
  }

  return (
    <div className="flex flex-col gap-6">
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

      <ConnectedAccountField workspaceId={workspaceId} account={account} />

      <SpreadsheetField
        formId={formId}
        value={spreadsheet}
        onChange={setSpreadsheet}
        options={sheets.data ?? []}
        pickerEnabled={account.pickerEnabled}
      />

      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="integration-backfill">Перенести уже накопленные ответы</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            Ответы, которые форма собрала раньше, уедут в таблицу сразу. У формы с тысячами
            ответов перенос займёт время.
          </p>
        </div>
        <Switch id="integration-backfill" checked={backfill} onCheckedChange={setBackfill} />
      </div>

      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          Не удалось подключить таблицу. Попробуйте ещё раз.
        </p>
      )}

      <Button
        size="lg"
        disabled={create.isPending}
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
    </div>
  )
}

// SpreadsheetField — куда класть ответы: новая книга, одна из созданных нами
// или любая своя таблица через окно выбора Google.
//
// Выбор с Диска нужен потому, что под scope drive.file «вставьте ссылку на свою
// таблицу» не работает в принципе: сервер не видит файл, которого не создавал.
// Picker — единственный способ дать выбрать свой файл, не прося доступ ко всему
// Диску (ADR §10).
function SpreadsheetField({
  formId,
  value,
  onChange,
  options,
  pickerEnabled,
}: {
  formId: string
  value: string
  onChange: (value: string) => void
  options: SpreadsheetRef[]
  pickerEnabled: boolean
}) {
  // picked — выбранная на Диске книга: её нет в списке созданных нами, поэтому
  // она добавляется отдельным пунктом, иначе Select не смог бы её показать.
  const [picked, setPicked] = useState<SpreadsheetRef | null>(null)
  const [pickerError, setPickerError] = useState('')
  const [opening, setOpening] = useState(false)

  async function openPicker() {
    setPickerError('')
    setOpening(true)
    try {
      const chosen = await pickSpreadsheet(await getPickerCredentials(formId))
      // null — окно закрыли, ничего не выбрав. Это не ошибка и не повод что-то
      // менять на экране.
      if (chosen) {
        setPicked(chosen)
        onChange(chosen.id)
      }
    } catch {
      setPickerError('Не удалось открыть окно выбора. Попробуйте ещё раз.')
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="integration-spreadsheet">Таблица</Label>
      <div className="flex gap-2">
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id="integration-spreadsheet" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEW_SPREADSHEET}>Создать новую таблицу</SelectItem>
            {options.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
            {picked && !options.some((s) => s.id === picked.id) && (
              <SelectItem value={picked.id}>{picked.name}</SelectItem>
            )}
          </SelectContent>
        </Select>
        {pickerEnabled && (
          <Button variant="outline" disabled={opening} onClick={openPicker}>
            {opening ? 'Открываем…' : 'Выбрать на Диске'}
          </Button>
        )}
      </div>
      {pickerError && (
        <p role="alert" className="text-xs text-destructive">
          {pickerError}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        У выбранной книги появится отдельный лист для этой формы. В списке — таблицы, созданные
        Trillix; любую другую свою можно выбрать на Диске.
      </p>
    </div>
  )
}

// ConnectAccount — первый шаг: рассказ и согласие. Ничего, кроме них, здесь нет.
function ConnectAccount({
  workspaceId,
  canManage,
}: {
  workspaceId: string
  canManage: boolean
}) {
  const [outcome, setOutcome] = useState<OAuthOutcome | null>(null)
  const popup = useOAuthPopup((result) => {
    // Успех подписи не требует: состояние перезапрошено, и на его месте
    // появятся настройки.
    setOutcome(result === 'integration_ok' ? null : result)
  })

  if (!canManage) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        Подключить Google может владелец пространства.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
        <li>• Каждый ответ ложится строкой в таблицу — через секунды после отправки.</li>
        <li>• Уже накопленные ответы можно перенести сразу.</li>
        <li>
          • Мы попросим доступ только к таблицам, которые создадим сами, — остальные файлы Диска
          останутся закрытыми.
        </li>
        <li>
          • Ответы, включая персональные данные респондентов, будут передаваться в сервис Google.
        </li>
      </ul>

      {/* Именно <a>, а не onClick+fetch: нужен полноценный переход браузера —
          XHR за редиректом на домен Google не пойдёт. Клик пробует открыть
          отдельное окно и гасит переход, только если это удалось. */}
      <Button asChild size="lg">
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

      {popup.waiting && <WaitingNote onCancel={popup.cancel} />}
      {outcome && (
        <p role="status" className="text-sm text-destructive">
          {connectFailureText(outcome)}
        </p>
      )}
    </div>
  )
}

// ConnectedAccountField — от чьего имени пишем. Подключение живёт у
// ПРОСТРАНСТВА, а не у формы, поэтому здесь оно показывается, а не выбирается:
// второй аккаунт — отдельная работа (спека §2).
function ConnectedAccountField({
  workspaceId,
  account,
}: {
  workspaceId: string
  account: FormIntegrations['account']
}) {
  const popup = useOAuthPopup(() => {})

  return (
    <div className="flex flex-col gap-2">
      <Label>Аккаунт Google</Label>
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
      {popup.waiting && <WaitingNote onCancel={popup.cancel} />}
    </div>
  )
}

// ConnectedBody — форма уже привязана: оверлей показывает состояние и действия.
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

// WaitingNote — ожидание согласия. Не второй модальный слой поверх первого:
// диалог в диалоге уводит фокус и запирает человека между двумя оверлеями, а
// окно провайдера и так сверху.
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
