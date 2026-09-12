import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { History, Pencil, Trash2 } from 'lucide-react'

import type { FormSheet, Webhook } from '../../entities/integration'
import { DeliveriesDialog } from './DeliveriesDialog'
import { GoogleSheetsOverlay } from './GoogleSheetsOverlay'
import { WebhookOverlay } from './WebhookOverlay'
import { GoogleSheetsIcon, WebhookIcon } from './ServiceIcon'
import {
  formIntegrationsQueryOptions,
  useDeleteWebhook,
  useUnlinkSheet,
  useUpdateConnection,
  useUpdateWebhook,
} from './queries'
import { Section } from '../../shared/page/Section'
import { ErrorState, LoadingRows } from '../../shared/page/states'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

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

// SERVICE_ICON — размер логотипа сервиса, общий для обоих блоков экрана. Знак
// один и тот же, и разный кегль в списке подключений и в каталоге читался бы как
// два разных сервиса. Константа, а не два одинаковых литерала: они разъезжаются
// ровно тогда, когда один из блоков правят.
const SERVICE_ICON = 'size-10'

// Overlay — какое окно настройки открыто. Вид цели входит в состояние: окон
// два (таблица и вебхук), и по одному id их больше не различить. id пуст —
// подключаем новую цель этого вида.
type Overlay = { kind: 'sheet' | 'webhook'; id: string | null }

export function IntegrationsView({ formId }: { formId: string }) {
  const state = useQuery(formIntegrationsQueryOptions(formId))
  const [overlay, setOverlay] = useState<Overlay | null>(null)

  if (state.isPending) {
    return <LoadingRows rows={2} />
  }
  if (state.isError || !state.data) {
    return <ErrorState title="Не удалось загрузить интеграции." onRetry={() => state.refetch()} />
  }

  const { connections, account, webhooks } = state.data
  const editingSheet = connections.find((c) => c.id === overlay?.id) ?? null
  const editingWebhook = webhooks.find((w) => w.id === overlay?.id) ?? null
  // Список непустой, когда есть хоть одна цель любого вида.
  const anyConnected = connections.length > 0 || webhooks.length > 0
  // Аккаунт, потерявший токен, — ЭТОТ, а не «аккаунт пространства»: связки одной
  // формы могут ехать разными подключениями (и даже чужими). Чужого в списке
  // спрашивающего нет, и про него мы правды не знаем — считаем, что всё цело:
  // соврать «сломано» про рабочую связку хуже, чем промолчать.
  const lost = (connection: FormSheet) =>
    account.accounts.find((a) => a.id === connection.accountId)?.needsReconnect ?? false

  return (
    <div className="flex flex-col gap-12">
      {/* Блок СИТУАТИВНЫЙ: при нуле связок его нет вовсе, и пустого состояния здесь
          не бывает. Обычно исчезающий раздел читается как недогрузившаяся страница —
          но не тут: сразу под ним стоит каталог с той же кнопкой «Подключить», и
          пустое состояние предлагало бы то же самое вторым голосом. */}
      {anyConnected && (
        <Section
          title="Мои подключения"
          description="Здесь собраны все интеграции, подключённые к этой форме. Интеграцию можно включить или выключить, а ход синхронизации ответов — посмотреть в журнале событий."
        >
          <ul className="flex flex-col gap-2">
            {connections.map((connection) => (
              <li key={connection.id}>
                <ConnectionRow
                  formId={formId}
                  connection={connection}
                  accountLost={lost(connection)}
                  onEdit={() => setOverlay({ kind: 'sheet', id: connection.id })}
                />
              </li>
            ))}
            {webhooks.map((webhook) => (
              <li key={webhook.id}>
                <WebhookRow
                  formId={formId}
                  webhook={webhook}
                  onEdit={() => setOverlay({ kind: 'webhook', id: webhook.id })}
                />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Доступные интеграции"
        description="Эти инструменты сделают Trillix ещё полезнее."
      >
        {/* Сетка, а не строки: каталог со временем станет длинным, и плитка с
            логотипом опознаётся с одного взгляда, тогда как одинаковые строки
            приходится читать. Один живой пункт; заглушек «скоро будет» здесь нет —
            они обещают срок, которого никто не давал. */}
        <ul className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          <li className="flex flex-col items-start">
            <GoogleSheetsIcon className={SERVICE_ICON} />
            <p className="mt-2 text-base font-semibold">Google Таблицы</p>
            <p className="mt-1 text-sm text-muted-foreground">Отправляйте ответы в таблицу</p>
            {/* Видимая надпись у обеих плиток одна — «Подключить»: она короткая и
                стоит под своим логотипом. Доступное имя при этом разное: вне
                плитки, списком кнопок, две одинаковые надписи неразличимы. */}
            <Button
              variant="link"
              className="mt-4 h-auto p-0 text-sm text-primary"
              aria-label="Подключить Google Таблицы"
              onClick={() => setOverlay({ kind: 'sheet', id: null })}
            >
              Подключить
            </Button>
          </li>
          <li className="flex flex-col items-start">
            <WebhookIcon className={SERVICE_ICON} />
            <p className="mt-2 text-base font-semibold">Вебхук</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Отправляйте ответы запросом на свой адрес
            </p>
            <Button
              variant="link"
              className="mt-4 h-auto p-0 text-sm text-primary"
              aria-label="Подключить вебхук"
              onClick={() => setOverlay({ kind: 'webhook', id: null })}
            >
              Подключить
            </Button>
          </li>
        </ul>
      </Section>

      {overlay?.kind === 'sheet' && (
        <GoogleSheetsOverlay
          formId={formId}
          state={state.data}
          connection={editingSheet}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay?.kind === 'webhook' && (
        <WebhookOverlay
          formId={formId}
          webhook={editingWebhook}
          onClose={() => setOverlay(null)}
        />
      )}
    </div>
  )
}

// ConnectionRow — одна работающая связка: состояние слева, управление справа.
//
// БЕЗ РАМКИ. Связок у формы единицы, и они однородны: рамка вокруг каждой рисует
// границу там, где различать нечего, — список читается как список, а не как стопка
// карточек.
//
// Действия стоят прямо в строке (тумблер, журнал, настройка, удаление), а не в
// меню «⋯»: они частые, и лишний клик по каждому дороже, чем компактность строки.
// Три значка собраны в одну группу и подписаны подсказками — см. ниже.
function ConnectionRow({
  formId,
  connection,
  accountLost,
  onEdit,
}: {
  formId: string
  connection: FormSheet
  // accountLost — аккаунт ЭТОЙ связки требует переподключения. Состояние
  // связки при этом всё ещё live: доставка узнает о беде, только когда придёт
  // ответ. Строка обязана сказать правду раньше — иначе человек видит зелёное
  // «синхронизируются» ровно до первого потерянного ответа.
  accountLost: boolean
  onEdit: () => void
}) {
  const update = useUpdateConnection(formId)
  const unlink = useUnlinkSheet(formId)
  const [confirming, setConfirming] = useState(false)
  const [log, setLog] = useState(false)
  const name = connection.name || 'Google Таблицы'

  return (
    <div className="flex items-center gap-3 py-3">
      <GoogleSheetsIcon className={`${SERVICE_ICON} shrink-0`} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-base font-semibold">
          <span className="truncate">{name}</span>
          <StatusDot {...sheetStatus(connection, accountLost)} />
        </p>
        {/* Строка под названием говорит, ЗАЧЕМ связка и куда ведёт ссылка.
            Состояние в ней не участвует: оно целиком на точке с тултипом, а
            держать его в двух местах значит однажды их рассинхронизировать —
            да и длинный текст поломки здесь обрезался бы на середине причины.

            Текст постоянный и не подстраивается под тумблер: у выключенной
            связки он описывает её назначение, а не сегодняшнее поведение —
            про «выключено» говорит точка рядом. */}
        <p className="mt-1 text-sm text-muted-foreground">
          Ответы синхронизируются с{' '}
          <a
            href={connection.url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            таблицей
          </a>
          {/* Через чей аккаунт едет связка. Аккаунтов у человека сколько угодно,
              и в команде связку мог завести коллега — без подписи строка не
              объясняет, почему её нельзя перенастроить. */}
          {connection.accountEmail && <> · {connection.accountEmail}</>}
        </p>
      </div>

      {/* Включённый тумблер — ярко-зелёный, а не цвета акцента: рядом с ним такой
          же зелёный кружок состояния, и разными оттенками они читались бы как два
          разных сигнала. Размер штатный: подменять геометрию вендоренного Switch
          нельзя без пересчёта хода бегунка — он записан как calc(100%-2px) от
          ширины бегунка и верен только для родной дорожки. */}
      <Switch
        className="data-[state=checked]:bg-success"
        checked={connection.enabled}
        disabled={update.isPending}
        aria-label={connection.enabled ? 'Выключить подключение' : 'Включить подключение'}
        onCheckedChange={(enabled) =>
          update.mutate({ id: connection.id, name: connection.name ?? '', enabled })
        }
      />
      {/* Журнал стоит ПЕРЕД настройкой и удалением: он про чтение, а соседи про
          правку, и деструктивное остаётся крайним справа. Действий в строке
          стало четыре — это всё ещё частые действия, а не повод прятать их в
          меню «⋯»: журнал открывают ровно тогда, когда ответ не нашёлся в
          таблице, то есть в тот же заход, что и настройки.

          Значки стоят ВПЛОТНУЮ, своей коробкой без gap (образец — строка ответа
          в SubmissionsTable), и это не экономия места: у ghost-кнопки граница —
          сам значок, а не край заливки, поэтому её собственные поля уже дают
          16 пикселей воздуха между соседями. Общий с текстом gap-3 добавлялся к
          ним сверху, и три значка читались как три отдельных действия вместо
          одной группы обслуживания связки. Тумблер в коробку не входит: он про
          состояние, а не про действие.

          Корзина отбита от соседей и краснеет на наведении: деструктивное
          отделяется даже в плотном ряду (DESIGN-SYSTEM, «действия строки»), а
          зазора для этого после уплотнения уже не хватает. */}
      <div className="flex items-center">
        <RowAction icon={History} label="Журнал доставок" onClick={() => setLog(true)} />
        <RowAction icon={Pencil} label="Настроить подключение" onClick={onEdit} />
        <RowAction
          icon={Trash2}
          label="Удалить подключение"
          className="ml-1 hover:text-destructive"
          onClick={() => setConfirming(true)}
        />
      </div>

      <DeliveriesDialog
        open={log}
        onOpenChange={setLog}
        formId={formId}
        target={{
          id: connection.id,
          kind: 'sheet',
          broken: connection.status === 'broken',
          enabled: connection.enabled,
        }}
      />

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

// WebhookRow — строка вебхука: то же устройство, что у связки Таблиц (состояние
// слева, тумблер и значки справа), потому что это одна и та же работа — «куда
// уезжают ответы». Разное только содержимое подписи и текст удаления.
//
// Адрес показан ХОСТОМ, а не целиком: в пути у Zapier и Make лежит токен
// получателя, и печатать его в списке незачем — полный адрес живёт в окне
// настройки, за правом на правку.
function WebhookRow({
  formId,
  webhook,
  onEdit,
}: {
  formId: string
  webhook: Webhook
  onEdit: () => void
}) {
  const update = useUpdateWebhook(formId)
  const remove = useDeleteWebhook(formId)
  const [confirming, setConfirming] = useState(false)
  const [log, setLog] = useState(false)
  const name = webhook.name || 'Вебхук'

  return (
    <div className="flex items-center gap-3 py-3">
      <WebhookIcon className={`${SERVICE_ICON} shrink-0`} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-base font-semibold">
          <span className="truncate">{name}</span>
          <StatusDot {...webhookStatus(webhook)} />
        </p>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          Ответы уходят на {webhook.host}
          {/* Очередь называется только когда она есть: «в очереди 0» — это шум,
              а вот растущее число объясняет, почему у получателя пусто. */}
          {webhook.queued > 0 && <> · в очереди {webhook.queued}</>}
        </p>
      </div>

      <Switch
        className="data-[state=checked]:bg-success"
        checked={webhook.enabled}
        disabled={update.isPending}
        aria-label={webhook.enabled ? 'Выключить вебхук' : 'Включить вебхук'}
        onCheckedChange={(enabled) => update.mutate({ id: webhook.id, enabled })}
      />
      <div className="flex items-center">
        <RowAction icon={History} label="Журнал доставок" onClick={() => setLog(true)} />
        <RowAction icon={Pencil} label="Настроить вебхук" onClick={onEdit} />
        <RowAction
          icon={Trash2}
          label="Удалить вебхук"
          className="ml-1 hover:text-destructive"
          onClick={() => setConfirming(true)}
        />
      </div>

      <DeliveriesDialog
        open={log}
        onOpenChange={setLog}
        formId={formId}
        target={{
          id: webhook.id,
          kind: 'webhook',
          broken: webhook.status === 'broken',
          enabled: webhook.enabled,
        }}
      />

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить вебхук?</AlertDialogTitle>
            <AlertDialogDescription>
              Новые ответы перестанут уходить на этот адрес. Ответы, которые ждали отправки, и
              журнал доставок будут удалены; сами ответы формы останутся на месте.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate(webhook.id)}>Удалить</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// RowAction — значок-действие в строке связки: кнопка плюс подсказка.
//
// Подпись живёт в ОДНОМ месте и работает дважды — доступным именем кнопки и
// текстом подсказки. Два литерала на одну надпись расходятся ровно тогда, когда
// правят один из них, и расхождение невидимо: скринридер читает одно, глаз
// видит другое.
//
// Подсказка радиксовая, а не нативный title: она красится токенами темы,
// открывается с клавиатуры и не ждёт секунду системной задержки. Цена —
// провайдер выше по дереву (в кабинете его даёт SidebarProvider, в тестах —
// TooltipProvider вокруг экрана); без него строка роняет рендер.
function RowAction({
  icon: Icon,
  label,
  className,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  className?: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={`text-muted-foreground ${className ?? ''}`}
          aria-label={label}
          onClick={onClick}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// StatusDot — состояние связки: цвет для взгляда, тултип для подробностей.
//
// Текст состояния живёт ЗДЕСЬ, а не строкой под названием: у поломки он длинный
// (причина плюс что делать), и в строке обрезался бы на середине. На точке он
// раскрывается целиком по наведению и по фокусу с клавиатуры.
//
// Точка ПУЛЬСИРУЕТ, пока состояние требует внимания или работы, — ореолом
// поверх (`animate-ping`), а не морганием самой точки: моргающий кружок теряется,
// расходящееся кольцо ловится боковым зрением в списке из десяти строк. У
// «работает» и «выключено» пульса нет: это покой, и подсвечивать в них нечего.
//
// Цвета — токенами (`bg-success`, `bg-warning`): литерал `bg-emerald-500` не имеет
// тёмного значения и не виден системе.
function StatusDot({
  color,
  label,
  text,
  pulsing,
}: {
  color: string
  label: string
  text: string
  pulsing: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* button, а не span: тултип обязан открываться и с клавиатуры, а до
            неинтерактивного узла фокус не доходит. type=button — строка лежит
            вне формы, но кнопка по умолчанию submit, и это ждёт своего часа. */}
        <button
          type="button"
          className="relative flex size-2 shrink-0 cursor-default rounded-full focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={label}
        >
          {pulsing && (
            <span
              className={`absolute inline-flex size-full animate-ping rounded-full opacity-75 ${color}`}
              aria-hidden
            />
          )}
          <span className={`relative inline-flex size-2 rounded-full ${color}`} aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{text}</TooltipContent>
    </Tooltip>
  )
}

// DotState — что показывает точка. Считается у каждого вида цели своим
// правилом: состояния у них разные («переносим накопленные» бывает только у
// таблицы, «в очереди» — только у вебхука), а вид точки один на оба.
interface DotState {
  color: string
  label: string
  text: string
  pulsing: boolean
}

function sheetStatus(connection: FormSheet, accountLost: boolean): DotState {
  if (!connection.enabled) {
    return {
      color: 'bg-muted-foreground/40',
      label: 'Выключено',
      text: 'Выключено: новые ответы в таблицу не уезжают. Таблица и всё, что уже в неё попало, на месте.',
      pulsing: false,
    }
  }
  // Потерянный аккаунт важнее статуса связки: чинится он, а не она.
  if (accountLost) {
    return {
      color: 'bg-destructive',
      label: 'Сломано',
      text: 'Доступ к Google потерян — подключите аккаунт заново. До этого ни один ответ не уедет.',
      pulsing: true,
    }
  }
  if (connection.status === 'broken') {
    return {
      color: 'bg-destructive',
      label: 'Сломано',
      text: 'Записать в таблицу не удаётся. Откройте настройки подключения.',
      pulsing: true,
    }
  }
  if (connection.status === 'backfilling') {
    return {
      color: 'bg-warning',
      label: 'Переносим ответы',
      text: 'Переносим ответы, которые уже пришли. Новые встанут в очередь и попадут в таблицу следом.',
      pulsing: true,
    }
  }
  return {
    color: 'bg-success',
    label: 'Работает',
    text: 'Ответы синхронизируются с таблицей.',
    pulsing: false,
  }
}

function webhookStatus(webhook: Webhook): DotState {
  if (!webhook.enabled) {
    return {
      color: 'bg-muted-foreground/40',
      label: 'Выключено',
      text: 'Выключено: новые ответы на этот адрес не уходят. Те, что ждали очереди, сняты.',
      pulsing: false,
    }
  }
  if (webhook.status === 'broken') {
    return {
      color: 'bg-destructive',
      label: 'Сломано',
      text:
        webhook.lastError ||
        'Отправить ответы на этот адрес не удаётся. Откройте настройки и нажмите «Проверить».',
      pulsing: true,
    }
  }
  // Копящаяся очередь — не поломка: получатель мог просто отвечать медленно, и
  // доставщик ждёт своего окна. Но молчать об этом нельзя — у человека в CRM
  // пусто, и причина должна называться.
  if (webhook.queued > 0) {
    return {
      color: 'bg-warning',
      label: 'Ответы ждут отправки',
      text: `Ответы ждут отправки: ${webhook.queued}. Отправим, как только получатель ответит.`,
      pulsing: true,
    }
  }
  return {
    color: 'bg-success',
    label: 'Работает',
    text: 'Ответы уходят на ваш адрес сразу после отправки формы.',
    pulsing: false,
  }
}
