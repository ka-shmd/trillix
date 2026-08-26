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
      {/* Колонкой flex, а не сеткой по умолчанию: только так работает max-h у самого
          окна, а список получает ВСЮ оставшуюся высоту через flex-1 + min-h-0.
          Пока окно было сеткой, его высоту задавало содержимое, и нижний край
          обрезал то, что не поместилось. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader className="shrink-0">
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
          <ScrollArea className="min-h-0 flex-1">
            {/* Поле справа — под полосу прокрутки: без него длинный ответ упирается
                в неё вплотную и читается как обрезанный. */}
            <ul className="flex flex-col pr-4">
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
          </ScrollArea>
        )}

        {/* Кнопка ВНЕ области прокрутки: внутри неё до кнопки приходилось
            доскроллить, и она же первой уходила под нижний край окна. Кнопка, а не
            подгрузка по прокрутке: автоподгрузка в своей области прокрутки не даёт
            добраться до конца списка ни мышью, ни клавиатурой. */}
        {answers.hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            className="w-full shrink-0"
            onClick={() => void answers.fetchNextPage()}
            disabled={answers.isFetchingNextPage}
          >
            {answers.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
