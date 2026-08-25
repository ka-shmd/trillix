import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Pencil, Table2, Trash2 } from 'lucide-react'

import type { FormSheet } from '../../entities/integration'
import { GoogleSheetsOverlay } from './GoogleSheetsOverlay'
import { GoogleSheetsIcon } from './ServiceIcon'
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
    return <LoadingRows rows={2} />
  }
  if (state.isError || !state.data) {
    return <ErrorState title="Не удалось загрузить интеграции." onRetry={() => state.refetch()} />
  }

  const { connections } = state.data
  const editing = connections.find((c) => c.id === overlay) ?? null

  return (
    <div className="flex flex-col gap-12">
      {/* Раздел рисуется и при нуле связок: блок, который просто исчезает, читается
          как недогрузившаяся страница, а вопрос «куда уезжают ответы» стоит и тогда,
          когда ответ — «никуда». */}
      <Section
        title="Мои подключения"
        description="Здесь собраны все интеграции, подключённые к этой форме. Интеграцию можно включить или выключить, а ход синхронизации ответов — посмотреть в журнале событий."
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
        description="Эти инструменты сделают Trillix ещё полезнее."
      >
        {/* Сетка, а не строки: каталог со временем станет длинным, и плитка с
            логотипом опознаётся с одного взгляда, тогда как одинаковые строки
            приходится читать. Один живой пункт; заглушек «скоро будет» здесь нет —
            они обещают срок, которого никто не давал. */}
        <ul className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          <li className="flex flex-col items-start">
            <GoogleSheetsIcon className="size-8" />
            <p className="mt-4 text-base font-semibold">Google Таблицы</p>
            <p className="mt-1 text-sm text-muted-foreground">Отправляйте ответы в таблицу</p>
            <Button
              variant="link"
              className="mt-4 h-auto p-0 text-sm text-primary"
              onClick={() => setOverlay('new')}
            >
              Подключить
            </Button>
          </li>
        </ul>
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

// ConnectionRow — одна работающая связка: состояние слева, управление справа.
//
// БЕЗ РАМКИ. Связок у формы единицы, и они однородны: рамка вокруг каждой рисует
// границу там, где различать нечего, — список читается как список, а не как стопка
// карточек.
//
// Действия стоят прямо в строке (тумблер, настройка, удаление), а не в меню «⋯»:
// их три, они частые, и лишний клик по каждому дороже, чем компактность строки.
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
    <div className="flex items-center gap-3 py-3">
      <GoogleSheetsIcon className="size-7 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-base font-semibold">
          <span className="truncate">{name}</span>
          <StatusDot
            status={connection.status}
            enabled={connection.enabled}
            accountLost={accountLost}
          />
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
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
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        aria-label="Настроить подключение"
        onClick={onEdit}
      >
        <Pencil className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
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

// StatusDot — состояние связки кружком без подписи: словом его уже говорит строка
// под названием («Ответы синхронизируются с…», «Записать не удаётся…»), и бейдж
// рядом повторял бы её вторым голосом.
//
// Подпись остаётся у скринридера (`aria-label`) — цвет для него не существует.
//
// Цвета — токенами (`bg-success`, `bg-warning`): литерал `bg-emerald-500` не имеет
// тёмного значения и не виден системе.
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
    ? ['bg-muted-foreground/40', 'Выключено']
    : status === 'broken' || accountLost
      ? ['bg-destructive', 'Сломано']
      : status === 'backfilling'
        ? ['bg-warning', 'Переносим ответы']
        : ['bg-success', 'Работает']

  return <span className={`size-2 shrink-0 rounded-full ${color}`} role="img" aria-label={label} />
}

function connectionSummary(connection: FormSheet, accountLost: boolean): string {
  if (!connection.enabled) return 'Ответы не синхронизируются с'
  // Потерянный аккаунт важнее статуса связки: чинится он, а не она.
  if (accountLost) return 'Доступ к Google потерян — подключите аккаунт заново; связано с'
  if (connection.status === 'broken') return 'Записать не удаётся — откройте настройки; связано с'
  if (connection.status === 'backfilling') return 'Переносим накопленные ответы в'
  return 'Ответы синхронизируются с'
}
