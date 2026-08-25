import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, MoreHorizontal, Pencil, Table2, Trash2 } from 'lucide-react'

import type { FormIntegrations, FormSheet } from '../../entities/integration'
import { GoogleSheetsOverlay } from './GoogleSheetsOverlay'
import { formIntegrationsQueryOptions, useUnlinkSheet, useUpdateConnection } from './queries'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
    return <LoadingRows rows={2} />
  }
  if (state.isError || !state.data) {
    return <ErrorState title="Не удалось загрузить интеграции." onRetry={() => state.refetch()} />
  }

  const { connections } = state.data
  const editing = connections.find((c) => c.id === overlay) ?? null

  return (
    <div className="flex flex-col gap-8">
      {/* Раздел рисуется и при нуле связок: блок, который просто исчезает, читается
          как недогрузившаяся страница, а вопрос «куда уезжают ответы» стоит и тогда,
          когда ответ — «никуда». */}
      <Section
        title="Мои подключения"
        description="Куда уезжают ответы этой формы. Подключений может быть несколько — например, в рабочую таблицу и в архивную."
      >
        {connections.length === 0 ? (
          <EmptyState
            icon={Table2}
            title="Пока ничего не подключено"
            description="Ответы этой формы никуда не уезжают автоматически — их видно в кабинете и в выгрузке CSV."
          />
        ) : (
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
        )}
      </Section>

      <Section
        title="Доступные интеграции"
        description="Ответы формы могут уезжать во внешние сервисы сами — сразу после отправки."
      >
        {/* Один живой пункт. Заглушек «скоро будет» здесь нет: они обещают срок,
            которого никто не давал. */}
        <Card className="flex-row items-center gap-3 p-4">
          <ServiceIcon />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Google Таблицы</p>
            <p className="text-sm text-muted-foreground">{catalogSummary(state.data)}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setOverlay('new')}>
            Подключить
          </Button>
        </Card>
      </Section>

      {overlay && (
        <GoogleSheetsOverlay
          formId={formId}
          state={state.data}
          connection={editing}
          onClose={() => setOverlay(null)}
        />
      )}
    </div>
  )
}

// Глиф сервиса. Подложка, а не голая иконка в потоке: в списке из нескольких
// интеграций она держит левую колонку ровной независимо от формы логотипа.
function ServiceIcon() {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
      <Table2 className="size-4 text-muted-foreground" aria-hidden />
    </span>
  )
}

// ConnectionRow — одна работающая связка: состояние слева, управление справа.
//
// СПРАВА РОВНО ДВА ОРГАНА: тумблер и меню. Тумблер видим, потому что это частое
// действие и одновременно показатель состояния; «Настроить», «Открыть таблицу» и
// «Удалить» уехали в меню — иначе удаление стоит в списке тем же весом, что и
// настройка. Тот же приём, что у строки пространства в сайдбаре.
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
  const name = connection.name || 'Google Таблицы'

  return (
    <Card className="flex-row items-center gap-3 p-4">
      <ServiceIcon />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{name}</span>
          <StatusBadge
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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Действия с подключением «${name}»`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="size-4" />
            Настроить подключение
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={connection.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              Открыть таблицу
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 className="size-4" />
            Удалить подключение
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
    </Card>
  )
}

// StatusBadge — состояние связки словом, а не цветной точкой: подпись у точки
// читал только скринридер, а глазами состояние приходилось выводить из текста
// ниже, который его и так повторял.
//
// Цвета — токенами (`bg-success`, `bg-warning`): литерал `bg-emerald-500` не имеет
// тёмного значения и не виден системе.
function StatusBadge({
  status,
  enabled,
  accountLost,
}: {
  status: FormSheet['status']
  enabled: boolean
  accountLost: boolean
}) {
  const [label, className] = !enabled
    ? ['Выключено', 'bg-muted text-muted-foreground']
    : status === 'broken' || accountLost
      ? ['Сломано', 'bg-destructive text-white']
      : status === 'backfilling'
        ? ['Переносим ответы', 'bg-warning text-warning-foreground']
        : ['Работает', 'bg-success text-success-foreground']

  return <Badge className={`shrink-0 border-transparent ${className}`}>{label}</Badge>
}

function connectionSummary(connection: FormSheet, accountLost: boolean): string {
  if (!connection.enabled) return 'Ответы не синхронизируются с'
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
