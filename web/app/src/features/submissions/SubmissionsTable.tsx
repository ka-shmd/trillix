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
//
// ТАБЛИЦА ИДЁТ ОТ КРАЯ ДО КРАЯ. Отрицательные боковые поля гасят поля колонки
// страницы (`-mx-5 sm:-mx-8` — ровно `px-5 sm:px-8` у PageContainer), а рамка
// остаётся только сверху и снизу: скруглённые углы, упирающиеся в края экрана,
// читаются как недоехавшая вёрстка. Поля возвращаются ТЕКСТУ — крайним клеткам,
// поэтому от края отступает содержимое, а не полоса.

// Вертикальная линия у каждой колонки, кроме последней: без неё длинный ответ
// сливается со следующей клеткой, и непонятно, где кончается один вопрос.
const DIVIDER = 'border-r last:border-r-0'

// Боковое поле крайних колонок = поле страницы: текст таблицы стоит на той же
// линии, что и текст над ней.
const EDGE_LEFT = 'pl-5 sm:pl-8'
const EDGE_RIGHT = 'pr-5 sm:pr-8'

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
  const lastIndex = columns.length - 1

  return (
    <div className="-mx-5 border-y sm:-mx-8">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className={`w-[230px] ${EDGE_LEFT} ${DIVIDER}`}>Дата отправки</TableHead>
            {showVersion && <TableHead className={`w-[96px] ${DIVIDER}`}>Версия</TableHead>}
            {columns.map((c, i) => (
              <TableHead
                key={c.block.id}
                className={`${DIVIDER} ${i === lastIndex ? EDGE_RIGHT : ''}`}
              >
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
              <TableCell className={`${EDGE_LEFT} ${DIVIDER}`}>
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
              {columns.map((c, i) => {
                const text = formatAnswer(c.block, s.answers[c.block.id], files)
                return (
                  <TableCell
                    key={c.block.id}
                    className={`${DIVIDER} ${i === lastIndex ? EDGE_RIGHT : ''}`}
                  >
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
