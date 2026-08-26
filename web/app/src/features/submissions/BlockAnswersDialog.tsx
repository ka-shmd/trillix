import { useInfiniteQuery } from '@tanstack/react-query'

import { blockAnswersQueryOptions } from './queries'
import { formatDate, pluralAnswers } from '../../shared/format'
import { ErrorState, LoadingRows } from '../../shared/page/states'
import { type Period } from '../../shared/period'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'

// Окно «все ответы на этот вопрос»: сводка показывает десять последних значений,
// здесь тот же вопрос листается целиком.
//
// Окно, а не переход в таблицу ответов: там строка — это ВЕСЬ ответ респондента со
// всеми полями, и найти в ней один вопрос значит читать таблицу вбок. Вопрос,
// открытый из своей же строки сводки, отвечает ровно на то, что спросили.
//
// Значения приходят готовым текстом с сервера (подпись опции, а не её id) — тем же
// рендером, что и в сводке над окном.
//
// Ширина окна — та же, что у колонки страницы (max-w-4xl, 896): ответы на вопрос
// читаются в той же мере строки, что и всё остальное в кабинете, а окно у́же
// страницы ломало бы длинный ответ переносами там, где на самой странице он бы
// поместился.
//
// ВЫСОТА ОБЛАСТИ ПРОКРУТКИ ЗАДАНА ЯВНО (max-h), а не долей свободного места
// (flex-1). У окна своей высоты нет — её задаёт содержимое, — поэтому доли считать
// не от чего: область вырастает по списку, прокрутка не включается вовсе, а список
// вываливается за нижний край окна. Кнопка «Показать ещё» при этом остаётся на
// своём месте у края и оказывается поверх строк.
//
// «Показать ещё» стоит В КОНЦЕ СПИСКА, внутри прокрутки, — там, где человек
// дочитал, а не прибитой к низу окна. Всё прокручиваемое обёрнуто ОДНИМ блоком с
// полями: Radix кладёт содержимое области в обёртку с display: table, и отступы
// прямых потомков в ней ведут себя не как в обычном потоке — кнопка вставала
// вплотную к нижнему краю и выглядела обрезанной. Правое поле того же блока —
// зазор под полосу прокрутки.
//
// Кнопка, а не подгрузка по прокрутке: автоподгрузка в своей области прокрутки не
// даёт добраться до конца списка ни мышью, ни клавиатурой.
export function BlockAnswersDialog({
  open,
  onOpenChange,
  formId,
  blockId,
  label,
  answered,
  period,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  formId: string
  blockId: string
  label: string
  answered: number
  period: Period
}) {
  const answers = useInfiniteQuery({
    ...blockAnswersQueryOptions(formId, blockId, period),
    // Запрос уходит только при открытом окне: иначе каждый вопрос сводки тянул бы
    // свою первую страницу заранее — у формы на двадцать вопросов это двадцать
    // запросов за данными, которых никто не просил.
    enabled: open,
  })
  const rows = answers.data?.pages.flatMap((p) => p.answers) ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="break-words">{label}</DialogTitle>
          <DialogDescription>
            {answered} {pluralAnswers(answered)} за выбранный период.
          </DialogDescription>
        </DialogHeader>

        {answers.isPending ? (
          <LoadingRows rows={4} />
        ) : answers.isError ? (
          <ErrorState title="Не удалось загрузить ответы." onRetry={() => answers.refetch()} />
        ) : (
          <ScrollArea className="max-h-[60vh]">
            <div className="pr-4 pb-2">
              <ul className="flex flex-col">
                {rows.map((a, i) => (
                  <li
                    key={`${a.at}-${i}`}
                    className="flex justify-between gap-4 border-b border-border/60 py-2 text-sm last:border-0"
                  >
                    <span className="min-w-0 break-words">{a.text}</span>
                    <span className="shrink-0 text-muted-foreground">{formatDate(a.at)}</span>
                  </li>
                ))}
              </ul>
              {answers.hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 w-full"
                  onClick={() => void answers.fetchNextPage()}
                  disabled={answers.isFetchingNextPage}
                >
                  {answers.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
                </Button>
              )}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}
