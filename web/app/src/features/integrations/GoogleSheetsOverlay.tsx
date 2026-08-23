import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, ExternalLink, RefreshCw, Table2 } from 'lucide-react'

import type { FormIntegrations, FormSheet, SpreadsheetRef } from '../../entities/integration'
import { useOAuthPopup, type OAuthOutcome } from '../../shared/oauthPopup'
import { getPickerCredentials, startUrl } from './api'
import { pickSpreadsheet } from './picker'
import {
  sheetsQueryOptions,
  spreadsheetsQueryOptions,
  useCreateSheet,
  useDisconnectAccount,
  useRefillSheet,
  useUpdateConnection,
} from './queries'
import { ApiError } from '../../shared/api/errors'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
// Пункты выбора, которые не являются id таблицы. Значения непустые: пустая
// строка у Select значит «ничего не выбрано» и роняет плейсхолдер.
//
// BROWSE — не выбор, а ДЕЙСТВИЕ внутри списка: открыть окно Google. Оно стоит
// пунктом, а не кнопкой рядом, потому что для человека это третий способ
// ответить на один и тот же вопрос «какая таблица», и разносить их по разным
// элементам управления значит делать вид, что вопросов два.
const NEW_SPREADSHEET = '__new__'
const BROWSE = '__browse__'
// NEW_SHEET — «завести новый лист в этой книге».
const NEW_SHEET = '__new_sheet__'

export function GoogleSheetsOverlay({
  formId,
  state,
  connection,
  onClose,
}: {
  formId: string
  state: FormIntegrations
  // connection — правим существующую связку; null — подключаем ещё одну.
  connection: FormSheet | null
  onClose: () => void
}) {
  // pickerOpen — открыто ли окно выбора файла Google.
  //
  // Мина: окно Picker'а Google рисует СВОИМ узлом в body, а модальный диалог
  // Radix на время своей жизни гасит pointer-events у всего, что вне его
  // содержимого, и держит фокус внутри. Окно выбора при этом видно — и оно
  // полностью мёртвое: ни клика, ни ввода. Поэтому на время выбора диалог
  // перестаёт быть модальным, а закрытие по клику мимо и по Escape гасится:
  // «мимо» теперь — это как раз окно Google.
  const [pickerOpen, setPickerOpen] = useState(false)
  // Настройки формы живут ЗДЕСЬ, а не внутри диалога.
  //
  // Мина: смена модальности меняет дерево Radix, и содержимое диалога
  // ПЕРЕМОНТИРУЕТСЯ вместе со всем локальным стейтом. Снаружи это выглядело как
  // «выбрал файл на Диске — оверлей перезагрузился, и ничего не произошло»:
  // выбранная книга и набранное имя исчезали ровно в тот момент, когда
  // возвращалась модальность.
  const setup = useSetupState(connection)

  return (
    <Dialog open modal={!pickerOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-svh max-h-svh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none border-none p-0 sm:max-w-none"
        style={{ top: 0, left: 0 }}
        onInteractOutside={(e) => pickerOpen && e.preventDefault()}
        onEscapeKeyDown={(e) => pickerOpen && e.preventDefault()}
      >
        <div className="mx-auto flex w-full max-w-lg flex-col gap-8 px-6 py-16">
          <header className="flex flex-col items-center gap-3 text-center">
            <Table2 className="size-8 text-muted-foreground" aria-hidden />
            <DialogTitle className="text-2xl">Google Таблицы</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Ответы этой формы будут ложиться строками в таблицу на вашем Google Диске.
            </p>
          </header>

          <SetupBody
            formId={formId}
            state={state}
            connection={connection}
            setup={setup}
            onDone={onClose}
            onPickerOpenChange={setPickerOpen}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

// LoadFailed — значок «не загрузилось» у подписи поля.
//
// Не абзац с объяснением: причина отказа — почти всегда наша (настройки проекта
// Google Cloud, доступность провайдера), и человеку нечего с ней делать. Экран
// показывает, что здесь не всё в порядке, и оставляет рабочий путь рядом;
// разбор — в логе, у того, кто может починить.
//
// Значок не немой: у него есть подпись для скринридера и подсказка на наведении —
// иначе для части людей он просто не существует.
function LoadFailed() {
  return (
    <span role="alert" aria-label="Не удалось загрузить" title="Не удалось загрузить">
      <AlertCircle className="size-3.5 text-destructive" aria-hidden />
    </span>
  )
}

// SetupState — набранные настройки подключения. Отдельным хуком, чтобы поля
// перечислялись один раз, а не расползались по сигнатурам компонентов.
interface SetupState {
  name: string
  setName: (value: string) => void
  spreadsheet: string
  setSpreadsheet: (value: string) => void
  sheet: string
  setSheet: (value: string) => void
  backfill: boolean
  setBackfill: (value: boolean) => void
  // picked — книга, выбранная в окне Google: её нет в списке созданных нами, и
  // без неё Select не смог бы показать выбранное.
  picked: SpreadsheetRef | null
  setPicked: (value: SpreadsheetRef | null) => void
}

// Правка открывается ТЕМ ЖЕ окном, что и подключение, и поля в нём —
// сегодняшние значения связки. Второй экран с другой раскладкой заставлял бы
// человека заново искать, где что: вопросы-то одни и те же.
function useSetupState(connection: FormSheet | null): SetupState {
  const [name, setName] = useState(connection?.name ?? '')
  const [spreadsheet, setSpreadsheetValue] = useState(
    connection ? connection.spreadsheetId : NEW_SPREADSHEET,
  )
  const [sheet, setSheet] = useState(connection ? String(connection.sheetId) : NEW_SHEET)
  // При правке перенос по умолчанию ВЫКЛЮЧЕН: связка уже работает, и молча
  // залить историю второй раз значит удвоить строки в чужой таблице.
  const [backfill, setBackfill] = useState(connection === null)
  const [picked, setPicked] = useState<SpreadsheetRef | null>(
    // Книга связки может быть не из нашего списка (выбрана на Диске) — тогда
    // без этого пункта Select не смог бы показать выбранное.
    connection ? { id: connection.spreadsheetId, name: connection.name || 'Текущая таблица' } : null,
  )

  return {
    name,
    setName,
    spreadsheet,
    setSpreadsheet: (value: string) => {
      setSpreadsheetValue(value)
      // Сменили книгу — выбранный лист относился к прежней.
      setSheet(NEW_SHEET)
    },
    sheet,
    setSheet,
    backfill,
    setBackfill,
    picked,
    setPicked,
  }
}

// SetupBody — путь подключения. До подключённого аккаунта настраивать нечего:
// показываем только рассказ и кнопку согласия. Поля, которые всё равно
// заперты, — это обещание работы, которой человек ещё не может сделать.
function SetupBody({
  formId,
  state,
  connection,
  setup,
  onDone,
  onPickerOpenChange,
}: {
  formId: string
  state: FormIntegrations
  connection: FormSheet | null
  setup: SetupState
  onDone: () => void
  onPickerOpenChange: (open: boolean) => void
}) {
  const { account, workspaceId } = state
  const create = useCreateSheet(formId)
  const update = useUpdateConnection(formId)
  const disconnect = useDisconnectAccount(workspaceId)
  const refill = useRefillSheet(formId)
  const saving = create.isPending || update.isPending
  const failed = create.isError || update.isError
  const failure = create.error ?? update.error

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
      {/* Состояние существующей связки — первым делом: человек открыл её, скорее
          всего, потому что что-то не так. */}
      {connection && <ConnectionState connection={connection} />}

      <div className="flex flex-col gap-2">
        <Label htmlFor="integration-name">Название подключения</Label>
        <Input
          id="integration-name"
          value={setup.name}
          maxLength={80}
          placeholder="Необязательно — чтобы отличать связки друг от друга"
          onChange={(e) => setup.setName(e.target.value)}
        />
      </div>

      <ConnectedAccountField workspaceId={workspaceId} account={account} />

      <SpreadsheetField
        formId={formId}
        setup={setup}
        options={sheets.data ?? []}
        listFailed={sheets.isError}
        pickerEnabled={account.pickerEnabled}
        onPickerOpenChange={onPickerOpenChange}
      />

      {/* Лист спрашиваем только у существующей книги: у новой он один и
          заводится вместе с ней. */}
      {setup.spreadsheet !== NEW_SPREADSHEET && (
        <SheetField
          formId={formId}
          spreadsheetId={setup.spreadsheet}
          value={setup.sheet}
          onChange={setup.setSheet}
        />
      )}

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
          checked={setup.backfill}
          onCheckedChange={setup.setBackfill}
        />
      </div>

      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {failure instanceof ApiError && failure.code === 'validation_failed'
            ? failure.message
            : 'Не удалось сохранить. Попробуйте ещё раз.'}
        </p>
      )}

      <Button size="lg" disabled={saving} onClick={() => save()}>
        {connection ? 'Сохранить' : 'Подключить Google Таблицы'}
      </Button>

      {connection && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <a href={connection.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" /> Открыть таблицу
            </a>
          </Button>
          {/* Перезалив — отдельное действие, а не тумблер сверху: он ЧИСТИТ лист
              и наполняет заново, и путать его с «перенести историю в новый лист»
              нельзя. */}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={refill.isPending || connection.status === 'backfilling'}
            onClick={() => refill.mutate(connection.id)}
          >
            <RefreshCw className="size-4" /> Перезалить всё
          </Button>
        </div>
      )}

      {account.canManage && (
        <div className="border-t pt-4">
          <Button
            variant="ghost"
            size="sm"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate(undefined, { onSuccess: onDone })}
          >
            Отключить Google от пространства
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            Снимет все подключения всех форм пространства.
          </p>
        </div>
      )}
    </div>
  )

  // save — одна кнопка на оба случая: подключаем новую связку либо сохраняем
  // правку существующей. Тумблер связки правкой не трогается: он живёт в
  // списке, и подменять его сохранением настроек нельзя.
  function save() {
    const target = {
      spreadsheetId: setup.spreadsheet === NEW_SPREADSHEET ? '' : setup.spreadsheet,
      sheetId:
        setup.spreadsheet === NEW_SPREADSHEET || setup.sheet === NEW_SHEET
          ? null
          : Number(setup.sheet),
      backfill: setup.backfill,
    }
    if (connection) {
      update.mutate(
        { id: connection.id, name: setup.name, enabled: connection.enabled, ...target },
        { onSuccess: onDone },
      )
      return
    }
    create.mutate({ name: setup.name, ...target }, { onSuccess: onDone })
  }
}

// SheetField — второй шаг выбора: в какой лист книги класть ответы. Существующий
// лист годится, только если его первая строка свободна: шапка ложится в A1, и
// затирать чужую работу мы не станем — сервер об этом скажет человеческим
// текстом, а рядом всегда есть «создать новый лист».
function SheetField({
  formId,
  spreadsheetId,
  value,
  onChange,
}: {
  formId: string
  spreadsheetId: string
  value: string
  onChange: (value: string) => void
}) {
  const sheets = useQuery(sheetsQueryOptions(formId, spreadsheetId))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Label htmlFor="integration-sheet">Лист</Label>
        {sheets.isError && <LoadFailed />}
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="integration-sheet" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NEW_SHEET}>Создать новый лист</SelectItem>
          {(sheets.data ?? []).length > 0 && (
            <SelectGroup>
              <SelectLabel>Листы книги</SelectLabel>
              {(sheets.data ?? []).map((sh) => (
                <SelectItem key={sh.id} value={String(sh.id)}>
                  {sh.title}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
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
  setup,
  options,
  listFailed,
  pickerEnabled,
  onPickerOpenChange,
}: {
  formId: string
  setup: SetupState
  options: SpreadsheetRef[]
  listFailed: boolean
  pickerEnabled: boolean
  onPickerOpenChange: (open: boolean) => void
}) {
  const [pickerFailed, setPickerFailed] = useState(false)
  const [opening, setOpening] = useState(false)

  async function openPicker() {
    setPickerFailed(false)
    setOpening(true)
    // Снимаем модальность ДО показа окна Google: иначе оно откроется поверх
    // диалога, у которого погашены pointer-events снаружи, и окажется мёртвым.
    onPickerOpenChange(true)
    try {
      const chosen = await pickSpreadsheet(await getPickerCredentials(formId))
      // null — окно закрыли, ничего не выбрав. Это не ошибка и не повод что-то
      // менять на экране.
      if (chosen) {
        setup.setPicked(chosen)
        setup.setSpreadsheet(chosen.id)
      }
    } catch {
      setPickerFailed(true)
    } finally {
      setOpening(false)
      onPickerOpenChange(false)
    }
  }

  const picked = setup.picked
  const known = picked && !options.some((s) => s.id === picked.id) ? [...options, picked] : options

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Label htmlFor="integration-spreadsheet">Таблица</Label>
        {(listFailed || pickerFailed) && <LoadFailed />}
      </div>
      <Select
        value={setup.spreadsheet}
        onValueChange={(next) => {
          // «Выбрать на Диске» — действие, а не значение: выбор остаётся
          // прежним, пока человек не укажет файл в окне Google.
          if (next === BROWSE) {
            void openPicker()
            return
          }
          setup.setSpreadsheet(next)
        }}
      >
        <SelectTrigger id="integration-spreadsheet" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NEW_SPREADSHEET}>Создать новую таблицу</SelectItem>
          {known.length > 0 && (
            <SelectGroup>
              <SelectLabel>Мои таблицы</SelectLabel>
              {known.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {pickerEnabled && (
            <SelectGroup>
              <SelectLabel>Добавить таблицу</SelectLabel>
              <SelectItem value={BROWSE}>
                {opening ? 'Открываем Google Диск…' : 'Выбрать на Google Диске'}
              </SelectItem>
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        В списке — таблицы, созданные Trillix: доступа к остальным файлам Диска у нас нет.
        Любую другую свою выберите на Google Диске.
      </p>
    </div>
  )
}

// ConnectionState — что сейчас со связкой. Причина поломки здесь единственное
// место, где её видно: это не техническая деталь провайдера, а состояние того,
// что человек настроил, и починка — в его руках (переподключить аккаунт).
function ConnectionState({ connection }: { connection: FormSheet }) {
  if (connection.status === 'broken') {
    return (
      <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
        {connection.lastError || 'Записать в таблицу не удаётся. Переподключите аккаунт.'}
      </p>
    )
  }
  if (connection.status === 'backfilling') {
    return (
      <p className="text-sm text-muted-foreground">
        Переносим ответы, которые уже пришли. Новые встанут в очередь и попадут в таблицу следом.
      </p>
    )
  }
  return (
    <p className="text-sm text-muted-foreground">
      {connection.lastDeliveredAt
        ? `Последний ответ уехал в таблицу ${formatMoment(connection.lastDeliveredAt)}.`
        : 'Ответы будут попадать в таблицу сразу после отправки.'}
    </p>
  )
}

// formatMoment — «23 августа, 14:05» человеку понятнее ISO-строки, а точность до
// минуты здесь всё, что нужно.
function formatMoment(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'недавно'
  return at.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
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
