import { useState } from 'react'
import { Eye, FileDown, Loader2, Trash2 } from 'lucide-react'

import { toast } from 'sonner'

import { type AnswerColumn } from './columns'
import { downloadSubmissionPdf } from './api'
import { formatAnswer } from './answerFormat'
import { DeleteAnswerDialog } from './DeleteAnswerDialog'
import { ROW_WORDS, rowWords, type AnswerRow } from './rows'
import { BlockTypeIcon } from '../../shared/BlockTypeIcon'
import { formatDateTime } from '../../shared/format'
import { type AnswerFile } from '../../entities/submission'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { humanError } from '../../shared/api/errors'

// Таблица раздела «Ответы»: СТРОКА — одна запись, КОЛОНКА — один вопрос. Таблица из
// даты и номера версии показывает ответы только по одному — окном на каждую строку,
// — и вопрос «что отвечали вот на это» в ней не задать. Значения для колонок ничего
// не стоят: они уже приезжают со страницей списка, внутри самой строки.
//
// Записи ДВА ВИДА — отправленный ответ и незавершённый; который перед нами, говорит
// `row.kind` (`rows.ts`). От него зависят подпись колонки даты и слова действий, а
// разметка, обрезка и поведение — одни на оба множества.
//
// Колонок ДВЕ — их отбирает `previewColumns` (columns.ts).
//
// Раскладка ФИКСИРОВАННАЯ (`table-fixed`): иначе ширину колонок назначает самый
// длинный ответ страницы, и таблица перекраивается на каждой подгрузке. Она же
// делает обрезку ячейки одной строкой предсказуемой — у клетки есть своя ширина, а
// не «сколько выторговала».
//
// СТРОКА НЕ НАЖИМАЕТСЯ и на наведение не красится (решение владельца). Действия строки —
// два значка, которые проступают в колонке даты, когда курсор над строкой: открыть ответ
// целиком и удалить.
//
// Значки гаснут ПРОЗРАЧНОСТЬЮ, а не `display: none`, и место занимают всегда: скрытые
// вторым способом они выпадают из порядка табуляции, а появляющиеся в потоке — сдвигают
// строку под курсором. Видимыми при фокусе их делает `group-focus-within`, поэтому
// невидимой кнопки под фокусом не бывает (тот же приём, что у строки формы в обзоре
// пространства).
//
// Кластер прижат к ПРАВОМУ краю своей колонки: колонки одной ширины, а дата короче
// колонки, и значки, стоящие сразу за текстом, вставали бы на разном расстоянии от
// границы у соседних строк. У правого края они собираются в одну вертикаль.
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
  formId,
  onOpen,
}: {
  rows: AnswerRow[]
  columns: AnswerColumn[]
  files: Record<string, AnswerFile>
  showVersion: boolean
  formId: string
  onOpen: (row: AnswerRow) => void
}) {
  const lastIndex = columns.length - 1
  // Одно окно подтверждения на таблицу, а не по окну на строку: подтверждают по одному,
  // а сотня смонтированных диалогов — сотня порталов на пустом месте.
  const [confirming, setConfirming] = useState<AnswerRow | null>(null)
  // Какая строка печатается прямо сейчас. Id, а не флаг: печать идёт секунды, и
  // ждать её обязан ровно тот значок, по которому нажали, — иначе таблица гасит
  // кнопки во всех строках разом.
  const [printing, setPrinting] = useState<string | null>(null)
  // Слова колонки даты и действий — по составу страницы: один вид строк называет
  // себя своими словами, смешанный («Все ответы») — нейтральными (`rows.ts`).
  const words = rowWords(rows)
  // Метка вида нужна ТОЛЬКО в смешанной таблице: на вкладке «Частичные» все строки
  // черновики, и повторять это в каждой из них — шум.
  const marked = words === ROW_WORDS.mixed

  // ПЕЧАТЬ ОТВЕТА (ADR §10). Файл готовит сервер: браузер печатает ту же страницу
  // формы, что видел респондент, поэтому ждать приходится секунды — значок на это
  // время превращается в вертушку, а не молчит.
  async function print(row: AnswerRow) {
    setPrinting(row.id)
    try {
      await downloadSubmissionPdf(formId, row.id)
    } catch (err) {
      toast.error(humanError(err, 'Не удалось напечатать ответ.'))
    } finally {
      setPrinting(null)
    }
  }

  return (
    <>
      <div className="-mx-5 border-y sm:-mx-8">
        <Table className="table-fixed">
          <TableHeader>
            {/* Подложка на наведении снята и у шапки: строки на неё не отвечают, и
                подсвеченная шапка выглядела бы единственным нажимаемым местом таблицы. */}
            <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
              <TableHead className={`${HEAD} ${EDGE_LEFT} ${DIVIDER}`}>
                {words.dateColumn}
              </TableHead>
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
            {rows.map((row) => (
              <TableRow
                key={row.id}
                className="group/row hover:bg-transparent dark:hover:bg-transparent"
              >
                <TableCell className={`${EDGE_LEFT} ${DIVIDER}`}>
                  <div className="flex items-center gap-2">
                    <span>{formatDateTime(row.at)}</span>
                    {marked && row.kind === 'partial' && (
                      <Badge variant="outline" className="font-normal text-muted-foreground">
                        не отправлен
                      </Badge>
                    )}
                    <span className="ml-auto flex items-center opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-7 text-muted-foreground"
                        aria-label={`Открыть ${words.oneLower} от ${formatDateTime(row.at)}`}
                        title={`Открыть ${words.oneLower}`}
                        onClick={() => onOpen(row)}
                      >
                        <Eye className="size-4" />
                      </Button>
                      {/* Печатается только ОТПРАВЛЕННЫЙ ответ: у черновика нет ни
                          версии, по которой его рисовать, ни самого события отправки,
                          а лист с подписью «отправлен» врал бы про то и другое. */}
                      {row.kind !== 'partial' && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-7 text-muted-foreground"
                          aria-label={`Скачать PDF ${words.oneLower} от ${formatDateTime(row.at)}`}
                          title="Скачать PDF"
                          disabled={printing === row.id}
                          onClick={() => void print(row)}
                        >
                          {printing === row.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <FileDown className="size-4" />
                          )}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        aria-label={`Удалить ${words.oneLower} от ${formatDateTime(row.at)}`}
                        title={`Удалить ${words.oneLower}`}
                        onClick={() => setConfirming(row)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </span>
                  </div>
                </TableCell>
                {showVersion && (
                  <TableCell className={`tabular-nums text-muted-foreground ${DIVIDER}`}>
                    {row.formVersion}
                  </TableCell>
                )}
                {columns.map((c, i) => {
                  const text = formatAnswer(c.block, row.answers[c.block.id], files)
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

      {confirming && (
        <DeleteAnswerDialog
          formId={formId}
          row={confirming}
          open
          onOpenChange={(next) => !next && setConfirming(null)}
        />
      )}
    </>
  )
}
