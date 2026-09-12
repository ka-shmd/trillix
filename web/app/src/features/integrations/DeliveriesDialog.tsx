import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Check, RotateCw, SkipForward, TriangleAlert } from 'lucide-react'

import type { Delivery } from '../../entities/integration'
import { deliveriesQueryOptions, useRetryDelivery, useRetryWebhookDelivery } from './queries'
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
// DeliveryTarget — чью ленту показываем. Окно одно на оба вида цели: у них
// одинаковая лента, одинаковый повтор и одна и та же мина двойного клика —
// вторая копия окна разъехалась бы с первой на первой же правке.
export interface DeliveryTarget {
  id: string
  kind: 'sheet' | 'webhook'
  // broken — у сломанной цели повтор не предлагается: её доставка гасится
  // первой же проверкой, и кнопка молча ничего не дала бы.
  broken: boolean
  // enabled — тумблер цели. У выключенной повтор тоже тупик: доставщик её не
  // берёт, и поставленный ответ висел бы в очереди до включения. Сервер такой
  // повтор отвергает (409), здесь мы не предлагаем.
  enabled: boolean
}

export function DeliveriesDialog({
  open,
  onOpenChange,
  formId,
  target,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  formId: string
  target: DeliveryTarget
}) {
  const isWebhook = target.kind === 'webhook'
  const log = useInfiniteQuery({
    // Запрос уходит только при открытом окне: целей у формы сколько угодно, и
    // тянуть ленту каждой заранее — это запросы за данными, которых не просили.
    ...deliveriesQueryOptions(formId, target),
    enabled: open,
  })
  // Оба хука вызываются всегда: правило хуков не разрешает выбирать их по
  // условию, а мутация без вызова ничего не делает.
  const retrySheet = useRetryDelivery(formId, target.id)
  const retryWebhook = useRetryWebhookDelivery(formId, target.id)
  const retry = isWebhook ? retryWebhook : retrySheet
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
            description={
              isWebhook
                ? 'Здесь появится каждая попытка отправить ответ на ваш адрес — и удачная, и нет.'
                : 'Здесь появится каждая попытка отправить ответ в таблицу — и удачная, и нет.'
            }
          />
        ) : (
          <ScrollArea className="max-h-[60vh]">
            <div className="pr-4 pb-2">
              <ul className="flex flex-col">
                {rows.map((d) => (
                  <li key={d.id} className="border-b border-border/60 py-3 last:border-0">
                    <DeliveryRow
                      delivery={d}
                      webhook={isWebhook}
                      /* Повтор у СЛОМАННОЙ и у ВЫКЛЮЧЕННОЙ цели не
                         показывается: её события гасятся первой же проверкой
                         доставки либо не берутся вовсе, и кнопка молча ничего не
                         дала бы. Сервер такой повтор и отвергает — здесь мы
                         просто не предлагаем тупик. */
                      canRetry={!target.broken && target.enabled && !queued.includes(d.id)}
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
  webhook,
  canRetry,
  retrying,
  onRetry,
}: {
  delivery: Delivery
  webhook: boolean
  canRetry: boolean
  retrying: boolean
  onRetry: () => void
}) {
  const { Icon, color, title } = outcomeMeta(delivery, webhook)
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
        {/* Код ответа получателя — рядом с причиной, а не вместо неё: причина
            объясняет, что делать, а код нужен тому, кто пойдёт смотреть логи на
            своей стороне. Пусто, когда ответа не было вовсе. */}
        {delivery.httpStatus !== undefined && (
          <p className="mt-0.5 text-sm text-muted-foreground">
            Код ответа: <span className="font-mono">{delivery.httpStatus}</span>
          </p>
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
function outcomeMeta(
  d: Delivery,
  webhook: boolean,
): {
  Icon: React.ComponentType<{ className?: string }>
  color: string
  title: string
} {
  if (d.outcome === 'delivered') {
    return {
      Icon: Check,
      color: 'text-success',
      title: webhook
        ? 'Ответ отправлен'
        : d.kind === 'backfill'
          ? `Перенесено накопленных ответов: ${d.rows}`
          : 'Ответ записан в таблицу',
    }
  }
  if (d.outcome === 'failed') {
    return {
      Icon: TriangleAlert,
      color: 'text-destructive',
      title: webhook ? 'Ответ не отправлен' : d.kind === 'backfill' ? 'Перенос не удался' : 'Ответ не записан',
    }
  }
  return { Icon: SkipForward, color: 'text-muted-foreground', title: 'Ответ не отправляли' }
}
