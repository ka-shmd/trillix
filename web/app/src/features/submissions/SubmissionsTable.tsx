import { type AnswerColumn } from './columns'
import { formatAnswer } from './answerFormat'
import { formatDateTime } from '../../shared/format'
import { type AnswerFile, type Submission } from '../../entities/submission'
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
// Колонок ДВЕ — их отбирает `previewColumns` (columns.ts).
//
// Раскладка ФИКСИРОВАННАЯ (`table-fixed`): иначе ширину колонок назначает самый
// длинный ответ страницы, и таблица перекраивается на каждой подгрузке. Она же
// делает обрезку ячейки одной строкой предсказуемой — у клетки есть своя ширина, а
// не «сколько выторговала».
//
// Дата — КНОПКА, а не текст: клик по строке открывает ответ, и до этого действия
// нужен путь с клавиатуры. Заодно она же и подсказка, что строка нажимается.
// Вертикальная линия у каждой колонки, кроме последней: без неё длинный ответ
// сливается со следующей клеткой, и непонятно, где кончается один вопрос.
const DIVIDER = 'border-r last:border-r-0'

export function SubmissionsTable({
  rows,
  columns,
  files,
  showVersion,
  onOpen,
}: {
  rows: Submission[]
  columns: AnswerColumn[]
  files: Record<string, AnswerFile>
  showVersion: boolean
  onOpen: (s: Submission) => void
}) {
  return (
    <div className="rounded-lg border">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className={`w-[190px] ${DIVIDER}`}>Дата отправки</TableHead>
            {showVersion && <TableHead className={`w-[96px] ${DIVIDER}`}>Версия</TableHead>}
            {columns.map((c) => (
              <TableHead key={c.block.id} className={DIVIDER}>
                <span className="block truncate" title={c.label}>
                  {c.label}
                </span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => (
            <TableRow key={s.id} className="cursor-pointer" onClick={() => onOpen(s)}>
              <TableCell className={DIVIDER}>
                <button
                  type="button"
                  className="font-medium hover:underline"
                  onClick={(e) => {
                    // Клик по кнопке всплыл бы до строки и открыл ответ дважды.
                    e.stopPropagation()
                    onOpen(s)
                  }}
                >
                  {formatDateTime(s.createdAt)}
                </button>
              </TableCell>
              {showVersion && (
                <TableCell className={`tabular-nums text-muted-foreground ${DIVIDER}`}>
                  {s.formVersion}
                </TableCell>
              )}
              {columns.map((c) => {
                const text = formatAnswer(c.block, s.answers[c.block.id], files)
                return (
                  <TableCell key={c.block.id} className={DIVIDER}>
                    {text ? (
                      <span className="block truncate" title={text}>
                        {text}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
