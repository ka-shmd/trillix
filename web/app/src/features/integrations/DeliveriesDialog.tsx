import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Check, RotateCw, SkipForward, TriangleAlert } from 'lucide-react'

import type { Delivery, FormSheet } from '../../entities/integration'
import { deliveriesQueryOptions, useRetryDelivery } from './queries'
import { humanError } from '../../shared/api/errors'
import { formatDateTime } from '../../shared/format'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'

// Журнал доставок связки: что уехало в таблицу, что не уехало и почему.
//
// До него о доставке было известно ровно одно — причина ПОСЛЕДНЕЙ неудачи на
// точке состояния. Этого хватает, чтобы понять «сломано», и не хватает, чтобы
// понять «когда и что именно»: канал «настроил и забыл» узнаёт о пропаже только
// пересчётом строк в чужой таблице.
//
// Окно, а не отдельная страница: журнал читают из строки связки, к которой он
// относится, и уводить ради него с экрана интеграций значит терять контекст —
// человек вернётся обратно тем же кликом.
//
// Строка ленты отвечает на три вопроса в порядке чтения: ЧТО везли (ответ или
// перенос), КАК кончилось (значок и заголовок), КОГДА (справа). Причина стоит
// под заголовком целиком — обрезать её нечем: у поломки текст длинный, и
// половина причины хуже её отсутствия.
export function DeliveriesDialog({
  open,
  onOpenChange,
  formId,
  connection,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  formId: string
  connection: FormSheet
}) {
  const log = useInfiniteQuery({
    ...deliveriesQueryOptions(formId, connection.id),
    // Запрос уходит только при открытом окне: связок у формы сколько угодно, и
    // тянуть ленту каждой заранее — это запросы за данными, которых не просили.
    enabled: open,
  })
  const retry = useRetryDelivery(formId, connection.id)
  // queued — строки, повтор которых УЖЕ поставлен в очередь в этом окне.
  //
  // ⚠ Без этого второй клик кладёт в чужую таблицу второй экземпляр ответа:
  // сервер отвечает 202 сразу (событие поставлено, а не доставлено), кнопка
  // разблокируется, а диспетчер просыпается только через 15 секунд — и оба
  // события доезжают. Серверный гейт от этого не спасает: он смотрит, доехал ли
  // ответ, а на момент второго клика не доехал ещё ни разу.
  const [queued, setQueued] = useState<string[]>([])
  const rows = log.data?.pages.flatMap((p) => p.deliveries) ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Журнал доставок</DialogTitle>
          <DialogDescription>События за последний месяц</DialogDescription>
        </DialogHeader>

        {log.isPending ? (
          <LoadingRows rows={4} />
        ) : log.isError ? (
          <ErrorState title="Не удалось загрузить журнал." onRetry={() => log.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Доставок пока не было"
            description="Здесь появится каждая попытка отправить ответ в таблицу — и удачная, и нет."
          />
        ) : (
          <ScrollArea className="max-h-[60vh]">
            <div className="pr-4 pb-2">
              <ul className="flex flex-col">
                {rows.map((d) => (
                  <li key={d.id} className="border-b border-border/60 py-3 last:border-0">
                    <DeliveryRow
                      delivery={d}
                      /* Повтор у СЛОМАННОЙ связки не показывается: её события
                         гасятся первой же проверкой доставки, и кнопка молча
                         ничего не дала бы. Сервер такой повтор и отвергает —
                         здесь мы просто не предлагаем тупик. */
                      canRetry={connection.status !== 'broken' && !queued.includes(d.id)}
                      retrying={retry.isPending && retry.variables === d.id}
                      onRetry={() =>
                        retry.mutate(d.id, {
                          onSuccess: () => setQueued((ids) => [...ids, d.id]),
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
              {/* Отказ повтора показывается один раз внизу списка, а не у строки:
                  причина у него общая на окно («связка сломана», «нет прав»), и
                  повторять её у каждой кнопки незачем. */}
              {retry.isError && (
                <p className="mt-3 text-sm text-destructive">{humanError(retry.error)}</p>
              )}
              {log.hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => void log.fetchNextPage()}
                  disabled={log.isFetchingNextPage}
                >
                  {log.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
                </Button>
              )}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}

function DeliveryRow({
  delivery,
  canRetry,
  retrying,
  onRetry,
}: {
  delivery: Delivery
  canRetry: boolean
  retrying: boolean
  onRetry: () => void
}) {
  const { Icon, color, title } = outcomeMeta(delivery)
  // Повторяют ОДИН ответ: у пачки переноса предмет — диапазон, и лечится он
  // перезаливом целиком, а не строкой. Успех не повторяют вовсе — у записи в
  // лист нет идемпотентности, и ответ лёг бы туда вторым разом.
  const retryable = canRetry && delivery.kind === 'submission' && delivery.outcome !== 'delivered'

  return (
    <div className="flex items-start gap-3">
      <Icon className={`mt-0.5 size-4 shrink-0 ${color}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {delivery.detail && (
          <p className="mt-0.5 text-sm break-words text-muted-foreground">{delivery.detail}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-sm text-muted-foreground">{formatDateTime(delivery.createdAt)}</span>
        {retryable && (
          <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
            <RotateCw className="size-3.5" aria-hidden />
            {retrying ? 'Ставим в очередь…' : 'Повторить'}
          </Button>
        )}
      </div>
    </div>
  )
}

// outcomeMeta — значок, цвет и заголовок строки.
//
// Цвета токенами: `--success` и `--destructive` здесь означают состояние, а
// пропуск красится нейтральным — это не беда, а решение, принятое за человека
// («связка была выключена», «ответ удалён»), и красный рядом с ним читался бы
// как поломка.
function outcomeMeta(d: Delivery): {
  Icon: React.ComponentType<{ className?: string }>
  color: string
  title: string
} {
  if (d.outcome === 'delivered') {
    return {
      Icon: Check,
      color: 'text-success',
      title:
        d.kind === 'backfill'
          ? `Перенесено накопленных ответов: ${d.rows}`
          : 'Ответ записан в таблицу',
    }
  }
  if (d.outcome === 'failed') {
    return {
      Icon: TriangleAlert,
      color: 'text-destructive',
      title: d.kind === 'backfill' ? 'Перенос не удался' : 'Ответ не записан',
    }
  }
  return { Icon: SkipForward, color: 'text-muted-foreground', title: 'Ответ не отправляли' }
}
