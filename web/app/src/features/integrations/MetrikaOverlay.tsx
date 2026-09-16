import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Hash, Loader2, Plus, RefreshCw, UserRound } from 'lucide-react'

import type {
  ConnectedAccount,
  FormIntegrations,
  MetrikaCounter,
} from '../../entities/integration'
import { CompactAction } from './CompactAction'
import { yandexStartUrl } from './api'
import {
  metrikaCountersQueryOptions,
  useCreateMetrikaCounter,
  useEnsureMetrikaGoals,
  useRefreshIntegrations,
  useSetMetrika,
} from './queries'
import { MetrikaIcon } from './ServiceIcon'
import { humanError } from '../../shared/api/errors'
import { useOAuthPopup, type OAuthOutcome } from '../../shared/oauthPopup'
import { RAISED_INPUT, RAISED_SELECT } from '../../shared/raisedField'
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
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Окно Яндекс Метрики — тот же полноэкранный оверлей, что у вебхука и Таблиц
// (фаза 29, design/yandex-metrika.md §8 и §13.5). Два пути к одному и тому же
// номеру счётчика: выбрать счётчик в подключённом аккаунте Яндекса (продукт заодно
// заводит три цели) или вписать номер руками.
//
// Ручной путь не запасной по значимости, а запасной по порядку: у агентства бывает
// доступ к форме и нет доступа к Метрике клиента, и на контуре без приложения
// Яндекса он единственный.
//
// Условия работы стоят на экране, а не в справке, — решение владельца 2026-09-15:
// до вики автору негде узнать, что встроенная форма без счётчика на сайте целей не
// отмечает. С появлением вики текст уезжает туда.

// Идентификаторы целей — контракт со счётчиком автора и зеркало GOAL_* в
// web/renderer/src/features/form/metrika.ts: разойдутся — цели, заведённые по этому
// экрану, не засчитаются никогда, и молча. Порядок — тот же, что в подзаголовке окна.
//
// Показываются ТОЛЬКО на ручном пути: когда счётчик выбран в аккаунте, цели заводит
// продукт, и читать их идентификаторы человеку незачем.
const GOAL_IDS = ['trillix_open', 'trillix_start', 'trillix_submit'] as const

// NEW_COUNTER — пункт «завести новый счётчик» в списке. Служебное значение
// селекта: номером счётчика оно быть не может — номер это цифры.
const NEW_COUNTER = 'new'

export function MetrikaOverlay({
  formId,
  formName,
  metrika,
  yandex,
  onClose,
}: {
  formId: string
  formName: string
  // metrika — правим подключённый счётчик; null — подключаем.
  metrika: MetrikaCounter | null
  // yandex — аккаунты Яндекса спрашивающего и настроено ли приложение на контуре.
  yandex: FormIntegrations['yandex']
  onClose: () => void
}) {
  const accounts = yandex.accounts
  // manual — ручной ввод номера. Без аккаунтов выбирать не из чего, поэтому он же
  // и стартовый; на контуре без приложения он единственный.
  const [manual, setManual] = useState(accounts.length === 0)
  // consent — открыт шаг согласия Яндекса. Первое подключение открывает его сразу:
  // за ним у человека нет ни аккаунта, ни счётчика, и показывать пустые поля
  // значило бы прятать единственное доступное действие за лишним нажатием.
  const [consent, setConsent] = useState<ConsentTarget | null>(
    yandex.enabled && accounts.length === 0 && metrika === null ? { account: null } : null,
  )
  const [outcome, setOutcome] = useState<OAuthOutcome | null>(null)

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [counter, setCounter] = useState(metrika?.counter ?? '')
  // counterName — имя нового счётчика; спрашивается, только когда выбран NEW_COUNTER.
  const [counterName, setCounterName] = useState('')
  // Имя по умолчанию — оно же подсказка в поле. Уходит в запросе явно, а не
  // пустым: серверное умолчание берёт сырой заголовок, и у безымянной формы
  // подсказка и имя в Метрике разошлись бы.
  const defaultCounterName = `Trillix: ${formName}`

  const save = useSetMetrika(formId)
  const goals = useEnsureMetrikaGoals(formId)
  const create = useCreateMetrikaCounter(formId)
  const refresh = useRefreshIntegrations(formId)

  const popup = useOAuthPopup((result) => {
    setOutcome(result === 'integration_ok' ? null : result)
    if (result === 'integration_ok') {
      setConsent(null)
      setManual(false)
      // Аккаунт подключился в соседнем окне: без перезапроса экран остался бы
      // показывать прежний список, а человек жал бы кнопку второй раз. Само оно
      // не обновится — refetch по фокусу слушает visibilitychange, а окно
      // провайдера поверх вкладки документ в hidden не переводит.
      refresh()
    }
  })

  // Только что подключённый аккаунт становится выбранным: человек нажал
  // «подключить» ради него. Отличаем по НОВОМУ id, а не по «последний в списке»:
  // переподключение прежнего аккаунта тоже двигает его в конец, но выбор при этом
  // трогать нельзя.
  const seen = useRef(new Set(accounts.map((a) => a.id)))
  useEffect(() => {
    const added = accounts.find((a) => !seen.current.has(a.id))
    for (const a of accounts) seen.current.add(a.id)
    if (added) setAccountId(added.id)
  }, [accounts])

  // Счётчик у формы появился, пока в селекте стоял «создать новый», — это наш
  // только что созданный (в том числе созданный, но с неудавшимися целями).
  // Выбор переезжает на него: иначе повторное нажатие завело бы ВТОРОЙ счётчик.
  //
  // Сверка в РЕНДЕРЕ, а не эффектом: эффект здесь даёт лишний каскадный рендер и
  // запрещён линтом (react-hooks/set-state-in-effect) — приём взят у настроек
  // формы (FormSettingsView).
  const formCounter = metrika?.counter ?? ''
  const [syncedCounter, setSyncedCounter] = useState(formCounter)
  if (syncedCounter !== formCounter) {
    if (counter === NEW_COUNTER && formCounter !== '') setCounter(formCounter)
    setSyncedCounter(formCounter)
  }

  const counters = useQuery({
    ...metrikaCountersQueryOptions(formId, accountId),
    enabled: !manual && consent === null && accountId !== '',
  })

  // Порядок обязателен: сначала номер, потом цели. Цели заводятся счётчику формы,
  // и до сохранения номера заводить их некуда — сервер ответил бы «у формы нет
  // счётчика». Отказ по целям окно НЕ закрывает: счётчик уже подключён, и
  // закрытие выглядело бы как «ничего не сохранилось».
  //
  // Повтор после отказа — то же действие целиком, номер сохраняется заново: между
  // попытками человек мог выбрать другой счётчик, а тот же номер PUT не меняет.
  async function connect() {
    // Новый счётчик — одно действие сервера: счётчик, номер у формы, цели.
    if (counter === NEW_COUNTER) {
      try {
        await create.mutateAsync({ accountId, name: counterName.trim() || defaultCounterName })
      } catch {
        // Счётчик мог создаться, а цели — нет; тогда номер уже у формы, и выбор
        // переедет на него эффектом ниже. Повтор пойдёт целями, а не вторым
        // счётчиком.
        return
      }
      onClose()
      return
    }
    try {
      // Тумблер окно не трогает: правка номера у выключенного счётчика его не
      // включает.
      await save.mutateAsync({ counter: counter.trim(), enabled: metrika?.enabled ?? true })
    } catch {
      return
    }
    if (manual || accountId === '') {
      onClose()
      return
    }
    try {
      await goals.mutateAsync(accountId)
    } catch {
      return
    }
    onClose()
  }

  // Окно занято: либо едут счётчики, либо человек в окне Яндекса. Состояние одно
  // и слой один, как у окна Таблиц; различаются подпись и «Отменить» у похода.
  // Повтор списка — тоже загрузка: isFetching держится и на паузе перед ним.
  // история — JOURNAL, «Загрузка счётчиков снова под общим слоем»
  const busy = counters.isFetching || popup.waiting
  const pending = save.isPending || goals.isPending || create.isPending

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-svh max-h-svh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none border-none p-0 sm:max-w-none"
        style={{ top: 0, left: 0 }}
      >
        <div
          inert={busy}
          className="mx-auto my-auto flex w-full max-w-xl flex-col gap-8 px-6 py-16"
        >
          <header className="flex flex-col items-center gap-3 text-center">
            <MetrikaIcon className="size-10" />
            <DialogTitle className="text-3xl">Яндекс Метрика</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Цели формы отмечаются в вашем счётчике: открыли, начали заполнять, отправили.
            </p>
          </header>

          {consent ? (
            <ConsentStep
              target={consent}
              connect={(href) => {
                setOutcome(null)
                return popup.open(href)
              }}
              outcome={outcome}
              // Назад некуда, пока нет ни аккаунта, ни счётчика: за шагом согласия
              // в этом случае пустой экран. Но ручной ввод есть всегда — он и
              // остаётся выходом.
              onBack={accounts.length > 0 || metrika !== null ? () => setConsent(null) : null}
              onManual={() => {
                setConsent(null)
                setManual(true)
              }}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {manual ? (
                <ManualField
                  counter={counter}
                  setCounter={setCounter}
                  // Кнопка выбора из аккаунта появляется, только если выбирать
                  // есть из чего: на контуре без приложения ручной путь
                  // единственный, и обещать второй нельзя.
                  onAccount={
                    yandex.enabled
                      ? () => {
                          setManual(false)
                          if (accounts.length === 0) setConsent({ account: null })
                        }
                      : null
                  }
                />
              ) : (
                <AccountFields
                  accounts={accounts}
                  accountId={accountId}
                  setAccountId={setAccountId}
                  counter={counter}
                  setCounter={setCounter}
                  counterName={counterName}
                  setCounterName={setCounterName}
                  defaultCounterName={defaultCounterName}
                  list={counters.data ?? []}
                  listFailed={counters.isError}
                  onRetryList={() => void counters.refetch()}
                  onConsent={setConsent}
                  onManual={() => setManual(true)}
                />
              )}

              <Conditions />

              {save.error != null && (
                <p role="alert" className="flex gap-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {humanError(save.error)}
                </p>
              )}
              {create.error != null && (
                <p role="alert" className="flex gap-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {humanError(create.error)}
                </p>
              )}
              {goals.error != null && (
                <p role="alert" className="flex gap-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  Счётчик подключён, но цели завести не удалось: {humanError(goals.error)}
                </p>
              )}
              {goals.data != null && goals.error == null && (
                <p role="status" className="text-sm text-muted-foreground">
                  {goals.data.created > 0
                    ? `Цели заведены в Метрике: ${goals.data.created}.`
                    : 'Все три цели уже заведены в этом счётчике.'}
                </p>
              )}

              {/* Одно действие во всю ширину, как в окнах вебхука и Таблиц. */}
              <Button
                size="lg"
                disabled={pending || counter.trim() === ''}
                onClick={() => void connect()}
              >
                {pending ? 'Сохраняем…' : metrika ? 'Сохранить' : 'Подключить'}
              </Button>
            </div>
          )}
        </div>

        {/* Слой поверх окна, пока оно занято: едут счётчики либо идёт поход за
            согласием. «Отменить» лежит ЗДЕСЬ, а не в колонке под слоем: колонка на
            это время inert. Отказ провайдера приходит на ЕГО стороне и к нам не
            возвращается — «Отменить» и есть выход из такого похода. */}
        {busy && (
          <div
            className="fixed inset-0 z-10 flex items-center justify-center gap-3 bg-background/85"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
            <span className="text-base text-muted-foreground">
              {popup.waiting ? 'Ждём подтверждения в окне Яндекса…' : 'Загружаем данные Яндекса…'}
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

// ConsentTarget — чей доступ обновляем: null — подключаем новый аккаунт.
interface ConsentTarget {
  account: ConnectedAccount | null
}

function ConsentStep({
  target,
  connect,
  outcome,
  onBack,
  onManual,
}: {
  target: ConsentTarget
  connect: (href: string) => boolean
  outcome: OAuthOutcome | null
  // onBack — вернуться к настройкам. null, когда возвращаться не к чему.
  onBack: (() => void) | null
  onManual: () => void
}) {
  const account = target.account
  const href = account ? yandexStartUrl(account.id) : yandexStartUrl()

  return (
    <div className="flex flex-col gap-5">
      {account && (
        <p className="text-center text-sm text-muted-foreground">
          Войдите в <span className="text-foreground">{account.email}</span> ещё раз, чтобы обновить
          доступ.
        </p>
      )}

      {/* Что именно спрашивается — до перехода, а не после: право на правку
          счётчиков Метрики шире, чем «заведи три цели», и узнать об этом человек
          должен здесь, а не на экране согласия Яндекса. */}
      <p className="text-sm text-muted-foreground">
        Продукт покажет список ваших счётчиков, заведёт в выбранном три цели, а если попросите —
        создаст новый счётчик. Доступ к Метрике выдаётся на правку счётчиков — снять его можно в
        настройках Яндекс ID.
      </p>

      {/* Именно <a>, а не onClick+fetch: нужен полноценный переход браузера —
          XHR за редиректом на домен Яндекса не пойдёт. Клик пробует открыть
          отдельное окно и гасит переход, только если это удалось. */}
      <Button asChild size="lg">
        <a
          href={href}
          onClick={(e) => {
            if (connect(href)) e.preventDefault()
          }}
        >
          {account ? 'Подключить заново' : 'Подключить аккаунт Яндекса'}
        </a>
      </Button>

      <div className="flex justify-center gap-1">
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            Назад
          </Button>
        )}
        <Button variant="ghost" onClick={onManual}>
          Ввести номер вручную
        </Button>
      </div>

      {outcome && (
        <p role="status" className="text-sm text-destructive">
          {connectFailureText(outcome)}
        </p>
      )}
    </div>
  )
}

// AccountFields — счётчик выбирается из аккаунта: поле аккаунта и поле счётчика.
// Строки с идентификаторами целей здесь нет — их заводит продукт.
function AccountFields({
  accounts,
  accountId,
  setAccountId,
  counter,
  setCounter,
  counterName,
  setCounterName,
  defaultCounterName,
  list,
  listFailed,
  onRetryList,
  onConsent,
  onManual,
}: {
  accounts: ConnectedAccount[]
  accountId: string
  setAccountId: (value: string) => void
  counter: string
  setCounter: (value: string) => void
  counterName: string
  setCounterName: (value: string) => void
  defaultCounterName: string
  list: { id: number; name: string; site: string }[]
  listFailed: boolean
  onRetryList: () => void
  onConsent: (target: ConsentTarget) => void
  onManual: () => void
}) {
  const chosen = accounts.find((a) => a.id === accountId) ?? null
  // Счётчика формы нет среди счётчиков аккаунта — его вписали руками или он
  // принадлежит другому аккаунту. Показываем отдельным пунктом: пустое поле у
  // подключённого счётчика выглядело бы как «номер потерялся». NEW_COUNTER
  // номером не является — иначе пункт «Текущий счётчик new» встаёт в список.
  const outside =
    counter !== '' && counter !== NEW_COUNTER && !list.some((c) => String(c.id) === counter)

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="metrika-account">Аккаунт Яндекса</Label>
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger id="metrika-account" className={`w-full ${RAISED_SELECT}`}>
            <SelectValue placeholder="Выберите аккаунт" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.email}
                {a.needsReconnect && ' — нужно переподключить'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Действия прижаты вправо: это обслуживание уже выбранного, а не
            следующий вопрос анкеты.

            «Переподключить» стоит ПОСТОЯННО, а не по признаку поломки (решение
            владельца 2026-09-10 на том же месте у Google): знание о смерти
            согласия всегда запаздывает — отзыв в Яндекс ID виден нам только в
            момент похода к Метрике, — и кнопка «когда есть что чинить» не
            появлялась бы ровно тогда, когда нужна. Адрес у обеих кнопок один;
            разницу делает почта выбранного аккаунта, уезжающая подсказкой.

            Отключения аккаунта здесь нет (решение владельца 2026-09-16): оно про
            аккаунт целиком, а окно — про счётчик одной формы. Ручка на бэке есть
            (API.md), её место — будущий экран аккаунта. */}
        <div className="flex justify-end">
          <CompactAction
            icon={Plus}
            label="Подключить другой аккаунт"
            onClick={() => onConsent({ account: null })}
          />
          {chosen && (
            <CompactAction
              icon={RefreshCw}
              label="Переподключить"
              onClick={() => onConsent({ account: chosen })}
            />
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="metrika-counter-select">Счётчик</Label>
        <Select value={counter} onValueChange={setCounter}>
          <SelectTrigger id="metrika-counter-select" className={`w-full ${RAISED_SELECT}`}>
            <SelectValue
              placeholder={listFailed ? 'Счётчики не загрузились' : 'Выберите счётчик'}
            />
          </SelectTrigger>
          <SelectContent>
            {/* Первым пунктом и отдельно от списка чертой, как «Создать новую
                таблицу» в окне Таблиц: у человека без Метрики это единственный
                путь, и прятать его под список счётчиков незачем. */}
            <SelectItem value={NEW_COUNTER}>Создать новый счётчик</SelectItem>
            {(outside || list.length > 0) && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>Мои счётчики</SelectLabel>
                  {outside && <SelectItem value={counter}>Текущий счётчик {counter}</SelectItem>}
                  {list.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {[c.name, c.site, c.id].filter((part) => part !== '').join(' · ')}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}
          </SelectContent>
        </Select>
        {/* Что произойдёт с выбранным счётчиком — сказано ДО нажатия: продукт
            заводит в нём цели, то есть меняет чужую настройку аналитики.
            Отдельного действия «Завести цели» нет (решение владельца
            2026-09-16): цели заводятся подключением, а кнопка-повтор на боевом
            счётчике стоила автору собранной статистики. */}
        {counter !== '' && (
          <p className="text-sm text-muted-foreground">
            {counter === NEW_COUNTER
              ? 'Заведём новый счётчик в вашей Метрике и сразу создадим в нём три цели формы. Цели он отметит только на странице формы: для формы, встроенной на ваш сайт, выберите счётчик, который уже стоит на сайте.'
              : 'В этом счётчике будут созданы три цели формы. Уже заведённые с теми же идентификаторами мы не трогаем.'}
          </p>
        )}
        <div className="flex justify-end">
          {/* Список не приехал — человеку нужны оба выхода: попробовать ещё раз
              и вписать номер руками. Второй рядом и так. */}
          {listFailed && <CompactAction icon={RefreshCw} label="Повторить" onClick={onRetryList} />}
          <CompactAction icon={Hash} label="Ввести номер вручную" onClick={onManual} />
        </div>
      </div>

      {/* Имя — отдельным полем ПОСЛЕ действий счётчика: «Ввести номер вручную»
          относится к выбору счётчика и стоит под ним, как у аккаунта. */}
      {counter === NEW_COUNTER && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="metrika-counter-name">Название счётчика</Label>
          <Input
            id="metrika-counter-name"
            className={RAISED_INPUT}
            value={counterName}
            // Зеркало MaxConnectionNameLen в internal/integrations.
            maxLength={80}
            placeholder={defaultCounterName}
            onChange={(e) => setCounterName(e.target.value)}
          />
        </div>
      )}
    </>
  )
}

// ManualField — сегодняшний путь: номер руками и одна строка о том, какие цели
// завести самому.
function ManualField({
  counter,
  setCounter,
  onAccount,
}: {
  counter: string
  setCounter: (value: string) => void
  // onAccount — уйти к выбору из аккаунта; null — приложение Яндекса на контуре
  // не настроено, и выбирать не из чего.
  onAccount: (() => void) | null
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="metrika-counter">Номер счётчика</Label>
      <Input
        id="metrika-counter"
        inputMode="numeric"
        autoFocus
        placeholder="12345678"
        className={RAISED_INPUT}
        value={counter}
        onChange={(e) => setCounter(e.target.value)}
      />
      {/* Одна строка текстом, без списка и кнопок (решение владельца
          2026-09-15): идентификатор выделяется и копируется как обычный текст. */}
      <p className="text-sm text-muted-foreground">
        Заведите в Метрике цели типа «JavaScript-событие» с идентификаторами{' '}
        {GOAL_IDS.map((id, i) => (
          <span key={id}>
            <span className="font-medium text-foreground">{id}</span>
            {i < GOAL_IDS.length - 2 ? ', ' : i === GOAL_IDS.length - 2 ? ' и ' : '.'}
          </span>
        ))}
      </p>
      {onAccount && (
        <div className="flex justify-end">
          <CompactAction
            icon={UserRound}
            label="Выбрать счётчик в аккаунте Яндекса"
            onClick={onAccount}
          />
        </div>
      )}
    </div>
  )
}

// Conditions — где цели отмечаются, а где нет. Стоит на обоих путях: вопрос не
// про то, как выбран номер.
function Conditions() {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold">Где отмечаются цели</p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
        <li>На странице формы — всегда.</li>
        <li>
          В форме, встроенной на сайт, — если на этом сайте установлен тот же счётчик и форма
          вставлена кодом с экрана «Встроить».
        </li>
        <li>Во вставке без загрузчика или ссылкой (Notion и подобные) цели не отмечаются.</li>
      </ul>
      <p className="text-sm text-muted-foreground">
        Вебвизор на форме не работает: то, что человек вводит в поля, не записывается.
      </p>
    </div>
  )
}

// connectFailureText — почему поход за согласием не удался. Тексты свои, а не
// общие с Google: у Метрики другой предмет доступа, и «доступ к Диску не выдан»
// здесь было бы ложью.
function connectFailureText(outcome: OAuthOutcome): string {
  switch (outcome) {
    case 'integration_denied':
      return 'Доступ к Метрике не выдан — без него список счётчиков спросить не у кого.'
    case 'integration_forbidden':
      return 'Подключение аккаунта Яндекса на этом контуре не настроено.'
    case 'integration_expired':
      return 'Подключение заняло слишком много времени. Попробуйте ещё раз.'
    default:
      return 'Не удалось подключить аккаунт Яндекса. Попробуйте ещё раз.'
  }
}
