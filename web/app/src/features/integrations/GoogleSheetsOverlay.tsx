import { useCallback, useEffect, useRef, useState } from 'react'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2, Plus, RotateCw, TriangleAlert, Upload } from 'lucide-react'

import type { LucideIcon } from 'lucide-react'

import type {
  ConnectedAccount,
  FormIntegrations,
  FormSheet,
  SpreadsheetRef,
} from '../../entities/integration'
import { useOAuthPopup, type OAuthOutcome } from '../../shared/oauthPopup'
import { getPickerCredentials, startUrl } from './api'
import { integrationKeys } from './keys'
import { pickSpreadsheet } from './picker'
import { GoogleSheetsIcon } from './ServiceIcon'
import {
  sheetsQueryOptions,
  spreadsheetsQueryOptions,
  useCreateSheet,
  useRefillSheet,
  useRefreshIntegrations,
  useUpdateConnection,
} from './queries'
import { ApiError } from '../../shared/api/errors'
import { Button } from '@/components/ui/button'
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
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
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

// ConsentTarget — ради чего открыт шаг согласия: подключить ещё один аккаунт
// (null) либо переподключить названный.
interface ConsentTarget {
  account: ConnectedAccount | null
}

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
  const setup = useSetupState(connection, state.account.accounts)

  // Поход за согласием живёт ЗДЕСЬ, а не в поле аккаунта, потому что здесь же
  // живёт слой поверх окна. Ожидание — такое же «окно занято», как и загрузка
  // списков: человек ушёл в окно Google, и настройки под ним трогать нечего.
  // Держать для этого вторую строку в колонке значило бы показывать занятость
  // двумя разными способами в одном окне.
  const [outcome, setOutcome] = useState<OAuthOutcome | null>(null)
  // consent — открыт ШАГ СОГЛАСИЯ: рассказ о том, что уходит в Google, и переход
  // к нему. Через него идут ВСЕ три пути (первое подключение, ещё один аккаунт,
  // переподключение), и это не церемония: на этом шаге стоит строка о передаче
  // персональных данных респондентов (спека design/integrations-gsheets.md §10),
  // а она обязана предварять КАЖДУЮ выдачу доступа, а не только первую.
  //
  // Значение — аккаунт, который переподключают, либо null для нового.
  //
  // Провайдер, не настроенный НА КОНТУРЕ, шага не открывает: там кнопки не
  // появится, и вместо неё экран обязан сказать, что интеграции здесь нет вовсе.
  const [consent, setConsent] = useState<ConsentTarget | null>(
    state.account.enabled && state.account.accounts.length === 0 && !connection
      ? { account: null }
      : null,
  )
  const refresh = useRefreshIntegrations(formId)
  const popup = useOAuthPopup((result) => {
    // Успех подписи не требует — но требует ПЕРЕЗАПРОСА: аккаунт подключился в
    // соседнем окне, и без этого экран остался бы показывать прежний список, а
    // человек жал бы кнопку второй раз. Само оно не обновится: refetch по фокусу
    // React Query слушает visibilitychange, а окно провайдера поверх вкладки
    // документ в hidden не переводит.
    setOutcome(result === 'integration_ok' ? null : result)
    if (result === 'integration_ok') {
      // Согласие получено — шаг отработал, возвращаемся к настройкам. Выбор в
      // них перескочит на свежий аккаунт сам (эффект ниже).
      setConsent(null)
      refresh()
    }
  })
  // connect — начать поход. Гасит прошлый исход и пробует открыть окно; false
  // означает «окно не открылось» (узкий экран, блокировщик), и тогда вызывающий
  // НИЧЕГО не делает, давая отработать обычному переходу по ссылке.
  const connect = (href: string) => {
    setOutcome(null)
    return popup.open(href)
  }

  // Только что подключённый аккаунт становится выбранным.
  //
  // Человек нажал «подключить» ради него — оставить выбор на прежнем значит
  // заставить его сделать вторым действием то, чего он и добивался первым; а
  // когда подключений не было вовсе, выбор оставался пустым и кнопка сохранения
  // запертой.
  //
  // Отличаем по НОВОМУ id, а не по «последний в списке»: переподключение
  // прежнего аккаунта тоже двигает его в конец (порядок — по connected_at), но
  // новых id не добавляет, и трогать выбор в этом случае нельзя — человек может
  // чинить один аккаунт, настраивая связку на другом.
  const seenAccounts = useRef(new Set(state.account.accounts.map((a) => a.id)))
  const { setAccount } = setup
  useEffect(() => {
    const added = state.account.accounts.find((a) => !seenAccounts.current.has(a.id))
    for (const a of state.account.accounts) seenAccounts.current.add(a.id)
    if (added) setAccount(added.id)
  }, [state.account.accounts, setAccount])

  // Что-нибудь ещё едет? Считаем ТОЛЬКО списки самого окна: ключ состояния формы
  // короче на один сегмент, и опрос переноса (раз в 3 секунды, пока связка
  // переносит накопленные ответы) иначе моргал бы индикатором на ровном месте.
  const loading = useIsFetching({
    predicate: (query) => {
      const key = query.queryKey
      const own = integrationKeys.form(formId)
      return key.length > own.length && key[0] === own[0] && key[1] === own[1]
    },
  })
  // Окно занято: либо едут списки, либо человек в окне Google. Состояние одно,
  // потому что и лечение одно — подождать; различаются только подпись и то, что
  // у похода есть «Отменить».
  const busy = loading > 0 || popup.waiting

  return (
    <Dialog open modal={!pickerOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-svh max-h-svh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none border-none p-0 sm:max-w-none"
        style={{ top: 0, left: 0 }}
        onInteractOutside={(e) => pickerOpen && e.preventDefault()}
        onEscapeKeyDown={(e) => pickerOpen && e.preventDefault()}
      >
        {/* my-auto, а не justify-center у родителя: родитель прокручиваемый, и
            центрирование через justify обрезало бы верх содержимого, когда оно выше
            окна. Так колонка стоит посередине, пока помещается, и прокручивается,
            когда нет. */}
        {/* inert, а не только слой поверх: накрывающий div ловит мышь, но не мешает
            дойти до полей табом. Атрибут выключает поддерево целиком — и для
            указателя, и для клавиатуры, и для скринридера. Фокус при этом
            уезжает на сам DialogContent (у него tabIndex=-1), то есть из окна не
            выпадает. */}
        <div
          inert={busy}
          className="mx-auto my-auto flex w-full max-w-xl flex-col gap-8 px-6 py-16"
        >
          <header className="flex flex-col items-center gap-3 text-center">
            <GoogleSheetsIcon className="size-10" />
            {/* Оверлей занимает весь экран, поэтому его заголовок берёт верхнюю
                ступень шкалы кеглей (docs/DESIGN-SYSTEM.md). Вес остаётся тот, что
                у DialogTitle. */}
            <DialogTitle className="text-3xl">Google Таблицы</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Отправляйте ответы формы прямо в Google Таблицы.
            </p>
          </header>

          {consent ? (
            <ConsentStep
              target={consent}
              connect={connect}
              outcome={outcome}
              // Назад некуда, пока не подключено ничего и правим не связку:
              // за шагом согласия в этом случае пустой экран настроек.
              onBack={
                state.account.accounts.length > 0 || connection ? () => setConsent(null) : null
              }
            />
          ) : (
            <SetupBody
              formId={formId}
              state={state}
              connection={connection}
              setup={setup}
              onDone={onClose}
              onPickerOpenChange={setPickerOpen}
              onConsent={setConsent}
            />
          )}
        </div>

        {/* Слой поверх окна, пока оно занято: едут списки либо идёт поход за
            согласием. Половина настроек зависит от того, что приедет (какие
            таблицы, какие листы), и трогать их раньше значит выбирать из пустого
            списка; на время похода трогать нечего тем более — человек в другом
            окне. fixed, а не absolute: окно прокручиваемое, и absolute уехал бы
            вместе с содержимым.

            Слой, а не второй диалог: диалог в диалоге уводит фокус и запирает
            человека между двумя оверлеями, а окно провайдера и так сверху.
            «Отменить» лежит ЗДЕСЬ, а не в колонке под слоем: колонка на это
            время inert, и кнопка в ней была бы недостижима. */}
        {busy && (
          <div
            className="fixed inset-0 z-10 flex items-center justify-center gap-3 bg-background/85"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
            <span className="text-base text-muted-foreground">
              {popup.waiting ? 'Ждём подтверждения в окне Google…' : 'Загружаем данные Google…'}
            </span>
            {popup.waiting && (
              <Button variant="ghost" size="sm" onClick={popup.cancel}>
                Отменить
              </Button>
            )}
          </div>
        )}
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
  // account — id выбранного подключения. Пусто = не выбрано (у нового человека
  // выбирать не из чего, пока он не подключит первый аккаунт).
  account: string
  setAccount: (value: string) => void
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
function useSetupState(connection: FormSheet | null, accounts: ConnectedAccount[]): SetupState {
  // Аккаунт связки при правке НЕ меняется, поэтому при правке он просто её
  // собственный. При заведении новой берём единственный, если он один, — выбор
  // из одного варианта человек всё равно делает не думая.
  const [account, setAccount] = useState(
    connection ? connection.accountId : (accounts[0]?.id ?? ''),
  )
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
    connection
      ? { id: connection.spreadsheetId, name: connection.name || 'Текущая таблица' }
      : null,
  )

  return {
    account,
    // useCallback не украшение: эта функция уходит в зависимости эффекта,
    // выбирающего только что подключённый аккаунт, и пересоздание её каждым
    // рендером гоняло бы эффект вхолостую.
    setAccount: useCallback((value: string) => {
      setAccount(value)
      // Сменили аккаунт — прежняя книга лежит в ЧУЖОМ Диске и этому аккаунту
      // недоступна (scope drive.file): выбор обязан начаться заново.
      setSpreadsheetValue(NEW_SPREADSHEET)
      setSheet(NEW_SHEET)
      setPicked(null)
    }, []),
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
  onConsent,
}: {
  formId: string
  state: FormIntegrations
  connection: FormSheet | null
  setup: SetupState
  onDone: () => void
  onPickerOpenChange: (open: boolean) => void
  // onConsent — уйти на шаг согласия. Сам поход к провайдеру начинается там:
  // предупреждение о передаче данных обязано предварять его (спека §10).
  onConsent: (target: ConsentTarget) => void
}) {
  const { account } = state
  const create = useCreateSheet(formId)
  const update = useUpdateConnection(formId)
  const saving = create.isPending || update.isPending
  const failed = create.isError || update.isError
  const failure = create.error ?? update.error

  // Список таблиц имеет смысл только у ВЫБРАННОГО аккаунта: это поход к
  // провайдеру его токеном.
  const sheets = useQuery({
    ...spreadsheetsQueryOptions(formId, setup.account),
    enabled: setup.account !== '',
  })

  if (!account.enabled) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        На этом контуре интеграция не настроена — обратитесь к администратору.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Состояние существующей связки — первым делом: человек открыл её, скорее
          всего, потому что что-то не так. */}
      {connection && (
        <ConnectionState
          formId={formId}
          connection={connection}
          // Человек уже выбрал другую цель — связка переезжает, и прежний лист
          // вместе со своей бедой перестаёт быть её делом.
          moving={
            setup.account !== connection.accountId ||
            setup.spreadsheet !== connection.spreadsheetId ||
            setup.sheet !== String(connection.sheetId)
          }
        />
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="integration-name">Название подключения</Label>
        <Input
          id="integration-name"
          className="h-10 md:text-base"
          value={setup.name}
          maxLength={80}
          placeholder="Необязательно — чтобы отличать связки друг от друга"
          onChange={(e) => setup.setName(e.target.value)}
        />
      </div>

      <AccountField
        accounts={account.accounts}
        connection={connection}
        setup={setup}
        onConsent={onConsent}
      />

      <SpreadsheetField
        accountId={setup.account}
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
          accountId={setup.account}
          spreadsheetId={setup.spreadsheet}
          value={setup.sheet}
          onChange={setup.setSheet}
        />
      )}

      <div className="flex items-start justify-between gap-4">
        <div>
          <Label htmlFor="integration-backfill">Перенести уже накопленные ответы</Label>
          {/* Кегль тот же, что у подписи над ним: пояснение к переключателю — такой
              же вторичный текст, а не сноска. */}
          <p className="mt-1 text-sm text-muted-foreground">
            Выгрузите все ответы формы в Google Таблицы. У формы с большим числом ответов выгрузка
            займёт время.
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

      <Button size="lg" disabled={saving || setup.account === ''} onClick={() => save()}>
        {connection ? 'Сохранить' : 'Подключить Google Таблицы'}
      </Button>
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
        {
          id: connection.id,
          name: setup.name,
          enabled: connection.enabled,
          accountId: setup.account,
          ...target,
        },
        { onSuccess: onDone },
      )
      return
    }
    create.mutate({ accountId: setup.account, name: setup.name, ...target }, { onSuccess: onDone })
  }
}

// SheetField — второй шаг выбора: в какой лист книги класть ответы. Существующий
// лист годится, только если его первая строка свободна: шапка ложится в A1, и
// затирать чужую работу мы не станем — сервер об этом скажет человеческим
// текстом, а рядом всегда есть «создать новый лист».
function SheetField({
  formId,
  accountId,
  spreadsheetId,
  value,
  onChange,
}: {
  formId: string
  accountId: string
  spreadsheetId: string
  value: string
  onChange: (value: string) => void
}) {
  const sheets = useQuery(sheetsQueryOptions(formId, accountId, spreadsheetId))

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Label htmlFor="integration-sheet">Лист</Label>
        {sheets.isError && <LoadFailed />}
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="integration-sheet" className="w-full text-base data-[size=default]:h-10">
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
  accountId,
  setup,
  options,
  listFailed,
  pickerEnabled,
  onPickerOpenChange,
}: {
  accountId: string
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
      const chosen = await pickSpreadsheet(await getPickerCredentials(accountId))
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
        <SelectTrigger
          id="integration-spreadsheet"
          className="w-full text-base data-[size=default]:h-10"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NEW_SPREADSHEET}>Создать новую таблицу</SelectItem>
          {known.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Мои таблицы</SelectLabel>
                {known.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
          {pickerEnabled && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Добавить таблицу</SelectLabel>
                <SelectItem value={BROWSE}>
                  {opening ? 'Открываем Google Диск…' : 'Выбрать на Google Диске'}
                </SelectItem>
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  )
}

// ConnectionState — что сейчас со связкой. Причина поломки здесь единственное
// место, где её видно: это не техническая деталь провайдера, а состояние того,
// что человек настроил, и починка — в его руках (переподключить аккаунт).
//
// РОВНО ДВА СОСТОЯНИЯ ГОВОРЯТ ВСЛУХ: сломано и переносим. Работающая связка молчит —
// ни «ответы будут попадать», ни «последний ответ уехал тогда-то»: первое повторяет
// то, ради чего связку заводили, второе отвечает на вопрос, которого никто не
// задавал, открывая настройки. Когда появится журнал доставок (BACKLOG), время
// последней уедет туда, где его ищут.
function ConnectionState({
  formId,
  connection,
  moving,
}: {
  formId: string
  connection: FormSheet
  // moving — в полях выбрана НЕ та цель, что записана у связки.
  moving: boolean
}) {
  // Перезалив живёт ВНУТРИ предупреждения, а не отдельной кнопкой рядом: причина
  // и выход из неё стоят в одном месте, и человеку не приходится догадываться,
  // что красный текст лечится кнопкой под ним. Из этого следует и обратное — у
  // работающей связки перезалива на экране нет, хотя он лечит и то, что молчит
  // (дубль после ретрая, строки, удалённые автором руками). Решение владельца
  // 2026-08-27; понадобится вход и в спокойном состоянии — ему место рядом с
  // журналом доставок, там же, где «повторить отправку» (BACKLOG).
  // Переезд сам по себе и есть лечение: в новом листе пишется свежая шапка,
  // колонки собираются заново, статус и last_error гасятся вместе с записью цели.
  // Поэтому предупреждения здесь нет — и, что важнее, нет кнопки перезалива:
  // она чистит СТАРЫЙ лист, тот самый, который человек в этот момент покидает.
  // Красный блок с разрушительным действием над покидаемой таблицей — худшее,
  // что можно показать посреди правки.
  if (moving) {
    return connection.status === 'broken' ? (
      <p className="text-sm text-muted-foreground">
        Связка переедет в другой лист — там будет своя шапка, и нынешняя ошибка уйдёт вместе с
        переездом.
      </p>
    ) : null
  }
  if (connection.status === 'broken') {
    return (
      <div
        role="alert"
        className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
      >
        <p className="flex gap-2 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <span>
            {connection.lastError || 'Записать в таблицу не удаётся. Переподключите аккаунт.'}
          </span>
        </p>
        {/* Отступ слева равен ширине значка с зазором: кнопка встаёт под текстом,
            а не под значком, и блок читается одной колонкой. */}
        <div className="pl-6">
          <RefillAction formId={formId} connectionId={connection.id} />
        </div>
      </div>
    )
  }
  if (connection.status === 'backfilling') {
    return (
      <p className="text-sm text-muted-foreground">
        Переносим ответы, которые уже пришли. Новые встанут в очередь и попадут в таблицу следом.
      </p>
    )
  }
  return null
}

// RefillAction — перезалить лист с нуля.
//
// Спрашивает подтверждение, и вопрос не формальный: перезалив чистит значения
// ВСЕГО листа, включая колонки, которые автор завёл себе сам (`A:ZZZ` в
// ClearSheet). Формат, ширина колонок и закрепление шапки переживают чистку —
// чистятся значения, а не лист, — но формула в своей колонке пропадёт вместе с
// ними. Умолчать об этом значит однажды стереть человеку работу без спроса.
function RefillAction({ formId, connectionId }: { formId: string; connectionId: string }) {
  const refill = useRefillSheet(formId)
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="flex">
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5"
        disabled={refill.isPending}
        onClick={() => setConfirming(true)}
      >
        <Upload className="size-3.5" />
        Перезалить лист
      </Button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Перезалить лист заново?</AlertDialogTitle>
            <AlertDialogDescription>
              Все значения листа будут стёрты — включая колонки, которые вы добавили в него сами, —
              и записаны заново: свежая шапка и все ответы формы. Оформление, ширина колонок и
              закрепление строк останутся.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => refill.mutate(connectionId)}>
              Перезалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ConsentStep — шаг согласия: что уйдёт в Google и переход к его окну.
//
// Через него идут ВСЕ походы к провайдеру — первое подключение, второй аккаунт,
// переподключение. Не церемония: здесь стоит строка о передаче персональных
// данных респондентов, и она обязана предварять КАЖДУЮ выдачу доступа. Пока
// «подключить ещё один» открывал окно Google сразу, эту строку человек видел
// один раз в жизни — при самом первом подключении.
//
// Права здесь не спрашиваются: человек подключает СВОЙ аккаунт Google, и роль в
// пространстве на это не влияет (ADR §10, 2026-08-27).
function ConsentStep({
  target,
  connect,
  outcome,
  onBack,
}: {
  target: ConsentTarget
  connect: (href: string) => boolean
  outcome: OAuthOutcome | null
  // onBack — вернуться к настройкам. null, когда возвращаться не к чему: до
  // первого подключения за этим шагом пустой экран.
  onBack: (() => void) | null
}) {
  const account = target.account
  const href = account ? startUrl(account.id) : startUrl()

  return (
    <div className="flex flex-col gap-5">
      {account && (
        <p className="text-center text-sm text-muted-foreground">
          Войдите в <span className="text-foreground">{account.email}</span> ещё раз — доступ к
          этому аккаунту потерян.
        </p>
      )}

      {/* Трансграничная передача названа ДО перехода к согласию, а не после:
          ответы уезжают в Google (США), и продукт не делает этого молча (спека
          design/integrations-gsheets.md §10, «Безопасность и 152-ФЗ»). Вторая
          половина той же меры — user_id в базе: запись, чьим согласием ответы
          уезжают наружу. */}
      <p className="text-sm text-muted-foreground">
        Ответы, включая персональные данные респондентов, могут быть переданы в сервисы Google.
      </p>

      {/* Именно <a>, а не onClick+fetch: нужен полноценный переход браузера —
          XHR за редиректом на домен Google не пойдёт. Клик пробует открыть
          отдельное окно и гасит переход, только если это удалось. */}
      <Button asChild size="lg">
        <a
          href={href}
          onClick={(e) => {
            if (connect(href)) e.preventDefault()
          }}
        >
          {account ? 'Подключить заново' : 'Подключить Google'}
        </a>
      </Button>

      {onBack && (
        <Button variant="ghost" onClick={onBack}>
          Назад
        </Button>
      )}

      {outcome && (
        <p role="status" className="text-sm text-destructive">
          {connectFailureText(outcome)}
        </p>
      )}
    </div>
  )
}

// AccountField — каким подключением ехать. СЕЛЕКТ, а не показ одного аккаунта:
// аккаунтов у человека сколько угодно (личный Диск и рабочий), и выбирает он их
// здесь же, где выбирает таблицу.
//
// Два действия стоят ПОД списком, а не пунктами в нём (образец — Tally): это не
// ответы на вопрос «чьим аккаунтом», а работа с самим подключением. Пункт-действие
// внутри списка оправдан у поля таблицы («Выбрать на Google Диске» — третий способ
// назвать таблицу), здесь же он смешал бы выбор с настройкой.
//
// «Отключить аккаунт» здесь НЕТ намеренно: отключение рвёт подключение целиком и
// каскадом уносит связки всех форм и пространств, которые им ехали, — а окно
// настраивает одну связку. Место для него — экран аккаунта, и оно записано в
// BACKLOG; ручка на бэке есть (API.md).
function AccountField({
  accounts,
  connection,
  setup,
  onConsent,
}: {
  accounts: ConnectedAccount[]
  // connection — правим существующую связку. Нужна ради ЧУЖОГО аккаунта: связку
  // мог завести коллега, его подключения в списке спрашивающего нет, и без
  // отдельного пункта Select показал бы пустое поле вместо «через кого едет».
  // Тот же приём, что у книги, выбранной в окне Google (`picked` ниже).
  connection: FormSheet | null
  setup: SetupState
  onConsent: (target: ConsentTarget) => void
}) {
  const chosen = accounts.find((a) => a.id === setup.account) ?? null
  // needsRepair — выбранный аккаунт требует починки, и починка эта одна: пройти
  // согласие Google заново.
  //
  // Две причины, и обе не видны до беды. Первая — refresh-токен не
  // расшифровывается ключом контура (ротация FORM_TOKEN_SECRET): тогда не
  // работает ни одна связка этого аккаунта. Вторая — человек отозвал доступ в
  // своём Google: токен цел, но провайдер отвечает invalid_grant, и связка
  // краснеет; узнаём об этом по её статусу.
  //
  // Вне этих двух случаев кнопки нет намеренно. Она ничего не добавляет к
  // соседней («Подключить другой аккаунт» ведёт на тот же адрес, и выбор того же
  // аккаунта в окне Google обновит строку) — вся разница в подсказке login_hint,
  // экономящей один клик. Постоянная кнопка предлагала бы чинить работающее.
  const needsRepair =
    chosen !== null &&
    (chosen.needsReconnect ||
      (connection?.status === 'broken' && connection.accountId === chosen.id))
  // Аккаунт связки, которого нет среди своих, — чужой: показываем его пунктом,
  // чтобы поле не выглядело пустым, но выбрать заново после ухода с него нельзя
  // (токена этого аккаунта у спрашивающего нет).
  const foreign =
    connection && !accounts.some((a) => a.id === connection.accountId)
      ? { id: connection.accountId, email: connection.accountEmail }
      : null

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="integration-account">Аккаунт Google</Label>
      <Select value={setup.account} onValueChange={setup.setAccount}>
        <SelectTrigger
          id="integration-account"
          className="w-full text-base data-[size=default]:h-10"
        >
          <SelectValue placeholder="Выберите аккаунт" />
        </SelectTrigger>
        <SelectContent>
          {foreign && (
            <SelectItem value={foreign.id}>{foreign.email} — подключение коллеги</SelectItem>
          )}
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Обе кнопки ведут на ОДИН адрес согласия, и это не дубль: у
          «Переподключить» с собой едет id выбранного аккаунта, его почта уходит
          провайдеру подсказкой (login_hint), и человек попадает сразу в нужный
          аккаунт вместо выбора из всех своих. Без выбранного аккаунта
          переподключать нечего — тогда кнопки нет. */}
      {/* Действия прижаты ВПРАВО и набраны мельче подписи поля: это не третий
          вопрос анкеты, а обслуживание того, что уже выбрано. Слева под селектом
          они читались бы продолжением формы и спорили с ней за очередь взгляда. */}
      <div className="flex flex-wrap items-center justify-end gap-1">
        <AccountAction
          icon={Plus}
          label="Подключить другой аккаунт"
          onClick={() => onConsent({ account: null })}
        />
        {needsRepair && chosen && (
          <AccountAction
            icon={RotateCw}
            label="Переподключить"
            onClick={() => onConsent({ account: chosen })}
          />
        )}
      </div>

      {/* Смена аккаунта у существующей связки — это переезд: таблица прежнего
          аккаунта новому под scope drive.file не видна, и поле «Таблица» уже
          сбросилось на «создать новую». Сказать это вслух обязательно — иначе
          человек сохранит правку, ожидая, что данные останутся в прежнем листе. */}
      {connection && setup.account !== connection.accountId && (
        <p className="text-sm text-muted-foreground">
          Прежняя таблица другому аккаунту недоступна — выберите или создайте таблицу в новом.
          Строки, уже доставленные в старую, останутся там.
        </p>
      )}

      {/* Потерянный токен важнее всего остального в этом поле: пока он не
          обновлён, ни одна связка этого аккаунта не работает, а лечение — рядом,
          кнопкой «Переподключить». */}
      {chosen?.needsReconnect && (
        <p role="alert" className="text-sm text-destructive">
          Доступ к этому аккаунту потерян — нажмите «Переподключить».
        </p>
      )}
    </div>
  )
}

// AccountAction — действие с подключением под списком аккаунтов.
//
// Вид взят у «Изменить» в строке формы (features/forms/FormRow.tsx) — это уже
// сложившийся в кабинете облик компактного действия со значком: ghost, поэтому
// на наведении подложка, а не подчёркивание. Свой облик здесь заводить незачем:
// задача та же, и второй вариант одного и того же читался бы как другой класс
// кнопки.
//
// Обычная кнопка, а не ссылка: наружу она больше не ведёт — открывает шаг
// согласия, а уже его большая кнопка уходит к провайдеру настоящим переходом
// (там же и запасной путь на случай заблокированного окна). Прежний <a href> на
// адрес похода был к тому же ловушкой: средний клик уводил вкладку из кабинета
// прямо на ручку OAuth.
function AccountAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-muted-foreground"
      onClick={onClick}
    >
      <Icon className="size-3.5" />
      {label}
    </Button>
  )
}

function connectFailureText(outcome: OAuthOutcome): string {
  switch (outcome) {
    case 'integration_denied':
      return 'Доступ к Google Диску не выдан — без него таблицу создать нечем.'
    // integration_forbidden остаётся в перечне (его шлёт бэк), но повода про
    // РОЛЬ у него больше нет: гейта по роли в подключении нет с 2026-08-27, и
    // единственный путь сюда — провайдер, не настроенный на контуре, между
    // открытием шага и возвратом из окна. Прежний текст «может только владелец
    // пространства» врал бы владельцу в лицо.
    case 'integration_forbidden':
      return 'Интеграция на этом контуре не настроена — обратитесь к администратору.'
    case 'integration_expired':
      return 'Подключение заняло слишком много времени. Попробуйте ещё раз.'
    default:
      return 'Не удалось подключить Google. Попробуйте ещё раз.'
  }
}
