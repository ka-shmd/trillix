import { useState } from 'react'
import { MoreHorizontal, PanelRightOpen, Trash2 } from 'lucide-react'

import { type AnswerColumn } from './columns'
import { formatAnswer } from './answerFormat'
import { useDeleteSubmission } from './queries'
import { formatDateTime } from '../../shared/format'
import { type AnswerFile, type Submission } from '../../entities/submission'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// Таблица ответов: СТРОКА — один ответ, КОЛОНКА — один вопрос. Таблица из даты и
// номера версии показывает ответы только по одному — окном на каждую строку, — и
// вопрос «что отвечали вот на это» в ней не задать. Значения для колонок ничего не
// стоят: они уже приезжают со страницей списка, внутри самой строки.
//
// Ячейка обрезается ОДНОЙ строкой: таблица нужна, чтобы окинуть взглядом много
// ответов, а абзац в клетке ломает ряд по высоте. Полный текст — в подсказке
// браузера (title) и в окне ответа по клику на строку.
//
// Две колонки ПРИБИТЫ к краям (sticky): дата слева и «⋯» справа. У формы на
// двадцать вопросов таблица листается вбок, и без этого нельзя ни понять, к какому
// ответу относится клетка, ни добраться до действий, не пролистав всё обратно.
//
// Подложка прибитых клеток — `bg-inherit`, а не свой токен: строка красится на
// наведении и при открытом меню, и клетка обязана краситься вместе с ней. Взамен
// строка получает НЕПРОЗРАЧНЫЙ фон (`bg-background`): наследовать прозрачность
// значит пустить прокручиваемый текст под прибитую клетку.
const CELL = 'block max-w-[26ch] truncate'

export function SubmissionsTable({
  rows,
  columns,
  files,
  showVersion,
  formId,
  onOpen,
}: {
  rows: Submission[]
  columns: AnswerColumn[]
  files: Record<string, AnswerFile>
  showVersion: boolean
  formId: string
  onOpen: (s: Submission) => void
}) {
  // Одно окно подтверждения на таблицу, а не по окну на строку: подтверждают по
  // одному, а сотня смонтированных диалогов — сотня порталов на пустом месте.
  const [confirming, setConfirming] = useState<Submission | null>(null)
  const remove = useDeleteSubmission(formId)

  return (
    <>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-background hover:bg-background">
              <TableHead className="sticky left-0 z-20 border-r bg-inherit">Заполнен</TableHead>
              {showVersion && <TableHead>Версия</TableHead>}
              {columns.map((c) => (
                <TableHead key={c.block.id}>
                  <span className={CELL} title={c.label}>
                    {c.label}
                  </span>
                </TableHead>
              ))}
              <TableHead className="sticky right-0 z-20 border-l bg-inherit">
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow
                key={s.id}
                className="cursor-pointer bg-background hover:bg-muted has-aria-expanded:bg-muted"
                onClick={() => onOpen(s)}
              >
                <TableCell className="sticky left-0 z-10 border-r bg-inherit font-medium">
                  {formatDateTime(s.createdAt)}
                </TableCell>
                {showVersion && (
                  <TableCell className="text-muted-foreground tabular-nums">
                    {s.formVersion}
                  </TableCell>
                )}
                {columns.map((c) => {
                  const text = formatAnswer(c.block, s.answers[c.block.id], files)
                  return (
                    <TableCell key={c.block.id}>
                      {text ? (
                        <span className={CELL} title={text}>
                          {text}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )
                })}
                <TableCell className="sticky right-0 z-10 border-l bg-inherit p-1 text-right">
                  {/* Действий у строки два, и оба редкие: открыть ответ целиком
                      можно и кликом по самой строке, а удаление — единственное
                      разрушающее действие экрана. Значит меню «⋯», а не кнопки в
                      ряд (docs/DESIGN-SYSTEM.md §7).

                      Клик по триггеру не должен всплывать до строки: иначе меню
                      открывается ОДНОВРЕМЕННО с окном ответа. */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground"
                        aria-label={`Действия с ответом от ${formatDateTime(s.createdAt)}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem onSelect={() => onOpen(s)}>
                        <PanelRightOpen className="size-4" />
                        Открыть ответ
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(s)}>
                        <Trash2 className="size-4" />
                        Удалить
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Удаление ответа необратимо и уносит чужие данные — подтверждение
          обязательно (docs/DESIGN-SYSTEM.md §7). */}
      <AlertDialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Удалить ответ от {confirming && formatDateTime(confirming.createdAt)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Это действие необратимо. Ответ исчезнет из таблицы, выгрузки и сводки.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={() => {
                if (confirming) remove.mutate(confirming.id)
                setConfirming(null)
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
