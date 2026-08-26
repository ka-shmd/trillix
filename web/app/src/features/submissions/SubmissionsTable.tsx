import { type AnswerColumn } from './columns'
import { formatAnswer } from './answerFormat'
import { BlockTypeIcon } from '../../shared/BlockTypeIcon'
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
// В шапке колонки стоит ГЛИФ ТИПА — тот же, что у вопроса на полотне редактора
// (`shared/blockIcons`). Он отвечает на вопрос, которого в подписи нет: «5» в клетке —
// это оценка по шкале, номер или выбранный вариант? Подпись вопроса при этом обрезана
// до одной строки, и у двух похоже названных колонок глиф часто единственное отличие,
// которое видно целиком. У ДАТЫ ОТПРАВКИ ГЛИФА НЕТ (решение владельца): он различает
// вопросы между собой, а дата в таблице одна, и путать её не с чем.
//
// КОЛОНКИ ОДИНАКОВОЙ ШИРИНЫ: своей ширины не назначено ни одной, и `table-fixed` делит
// место поровну. Назначенная в пикселях колонка на широком экране остаётся узкой
// полосой, вокруг которой копится пустота, а на узком — режет соседей.
//
// ТАБЛИЦА ИДЁТ ОТ КРАЯ ДО КРАЯ. Отрицательные боковые поля гасят поля колонки
// страницы (`-mx-5 sm:-mx-8` — ровно `px-5 sm:px-8` у PageContainer), а рамка
// остаётся только сверху и снизу: скруглённые углы, упирающиеся в края экрана,
// читаются как недоехавшая вёрстка. Поля возвращаются ТЕКСТУ — крайним клеткам,
// поэтому от края отступает содержимое, а не полоса.

// Вертикальная линия у каждой колонки, кроме последней: без неё длинный ответ
// сливается со следующей клеткой, и непонятно, где кончается один вопрос.
const DIVIDER = 'border-r last:border-r-0'

// Шапка набрана ЛЕГЧЕ СТРОКИ ДАННЫХ и цветом, и весом, и стоит чуть выше неё: подписи
// колонок читают один раз, а значения постоянно, и шапка вровень с ними спорит за
// внимание. Вес перебивается тем же плоским `font-*`, а высота тем же плоским `h-*`,
// какими они заданы у вендоренного TableHead (`font-medium`, `h-10`).
//
// ДАЛЬШЕ СВЕТЛЕТЬ НЕКУДА. `--muted-foreground` держит к холсту 4,97:1 — сам по себе едва
// выше порога AA (4,5:1 для текста 14px); под 80% прозрачности остаётся 3,34:1, и это уже
// уступка виду. 70% дают 2,79:1 — там подпись колонки перестаёт читаться на светлой теме.
const HEAD = 'h-11 font-normal text-muted-foreground/80'

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
            <TableHead className={`${HEAD} ${EDGE_LEFT} ${DIVIDER}`}>Дата отправки</TableHead>
            {showVersion && <TableHead className={`${HEAD} ${DIVIDER}`}>Версия</TableHead>}
            {columns.map((c, i) => (
              <TableHead
                key={c.block.id}
                className={`${HEAD} ${DIVIDER} ${i === lastIndex ? EDGE_RIGHT : ''}`}
              >
                <span className="flex min-w-0 items-center gap-1.5" title={c.label}>
                  <BlockTypeIcon type={c.block.type} className="shrink-0" />
                  <span className="truncate">{c.label}</span>
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
                  className="hover:underline"
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
