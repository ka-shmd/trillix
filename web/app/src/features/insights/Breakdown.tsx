import { ChevronRight } from 'lucide-react'
import { Fragment, useState } from 'react'

import { conversionText, percentText } from './metrics'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

// Строка-полоска — ЕДИНСТВЕННАЯ форма «подпись, величина, доля» во всей аналитике:
// распределения сводки, разбивки визитов, шаги воронки. Заводить свою разметку
// полоски запрещено: три почти одинаковых вида одного и того же читаются как
// небрежность, а не как разница смысла.
//
// ТАБЛИЦА (подача «Б», решение владельца 2026-09-20: три подачи показывались на
// живых числах, выбрана эта). Что она даёт против прежнего списка:
//
//   - у каждой колонки есть ШАПКА. Пока чисел в строке было два, «26 %» рядом с
//     «2051 · 26 %» не отличалось от доли ничем, кроме порядка;
//   - вторые величины (ушедшие, конверсия, время) встают своими колонками вместо
//     серой приписки под каждой строкой. Приписок было столько же, сколько строк,
//     и они занимали половину высоты раздела мелким серым текстом;
//   - полоска толще (20 px вместо 10) и работает ячейкой таблицы, а не тонкой
//     чёрточкой в воздухе.
//
// Полоска СПЛОШНАЯ и стоит в своей колонке. Заливкой ПОД текстом она быть не может:
// под буквами ей приходится оставаться бледной, иначе текст не читается, — и
// величина рисуется пятном в четверть насыщенности, неотличимым от подсветки строки
// под курсором. В своей колонке она берёт полный тон --chart-1, а подпись остаётся
// чёрной на белом: цвет достаётся данным, а не фону под буквами.

export type BarRow = {
  key: string
  label: React.ReactNode
  // Главная колонка — готовый текст: «613 · 30 %», «4127 · 52 %». Собирает его
  // вызывающий, потому что доля у экранов считается от разных баз, и подставлять
  // её здесь значило бы навязать одну базу всем.
  value: React.ReactNode
  // Доля заливки 0..1. База — забота вызывающего (у распределения это ответившие,
  // у разбивки визитов — сумма разбивки, у воронки — визиты формы).
  share: number
  // Хвост заливки, нарисованный светлее: у шага воронки это ушедшие. Доля от той
  // же базы, что share, и всегда его часть.
  lost?: number
  // Значения дополнительных колонок — по одному на каждую из columns.extras.
  // Пусто в клетке — прочерк, а не пустота: пустая ячейка читается как «не
  // догрузилось».
  extras?: React.ReactNode[]
  // Подложка строки: та, о которой сейчас речь, — худший шаг воронки, применённое
  // условие выборки. Не цвет состояния: это место на графике, а не отказ системы
  // (docs/DESIGN-SYSTEM.md, роли цвета).
  highlight?: boolean
  // Вложенные строки: вопросы страницы внутри шага воронки. Строка с детьми
  // раскрывается щелчком по себе — раздела со своим выпадающим списком под таблицей
  // для этого не нужно.
  children?: BarRow[]
  // Щелчок по строке применяет её к выборке экрана («оставить только этих»).
  // actionLabel — имя этого действия для скринридера: видимая подпись строки
  // называет значение, а не то, что с ним произойдёт.
  onSelect?: () => void
  actionLabel?: string
}

// Шапки колонок. value обязателен: без имени главное число строки остаётся
// безымянным, а их в строке бывает три.
export type BarColumns = { label: string; value: string; extras?: string[] }

export function BarRows({
  rows,
  columns,
  className,
}: {
  rows: BarRow[]
  columns: BarColumns
  className?: string
}) {
  const extras = columns.extras ?? []
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  return (
    <table className={cn('w-full text-sm', className)}>
      <thead>
        <tr className="border-b">
          <Th className="text-left">{columns.label}</Th>
          {/* Колонка полоски — без шапки: величина у неё та же, что в следующей
              колонке, и второе имя над ней читалось бы как второе число.

              Ширина ДОЛЕЙ, а не `w-full`: с `w-full` полоска забирала всё
              свободное место, и колонка подписи сжималась до минимума по
              содержимому — «Открыли форму» переносилось на две строки там, где
              места хватало с запасом. */}
          <th className="hidden w-2/5 sm:table-cell" />
          <Th>{columns.value}</Th>
          {extras.map((e) => (
            <Th key={e}>{e}</Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const expanded = open.has(row.key)
          return (
            <Fragment key={row.key}>
              <Row
                row={row}
                extras={extras.length}
                expanded={row.children && row.children.length > 0 ? expanded : undefined}
                onToggle={() =>
                  setOpen((prev) => {
                    const next = new Set(prev)
                    if (!next.delete(row.key)) next.add(row.key)
                    return next
                  })
                }
              />
              {expanded &&
                row.children?.map((child) => (
                  <Row key={child.key} row={child} extras={extras.length} nested />
                ))}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'pb-2 pl-4 text-right font-normal whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      {children}
    </th>
  )
}

function Row({
  row,
  extras,
  expanded,
  onToggle,
  nested,
}: {
  row: BarRow
  extras: number
  // undefined — строка не раскрывается (детей нет).
  expanded?: boolean
  onToggle?: () => void
  nested?: boolean
}) {
  const lost = Math.min(row.lost ?? 0, row.share)
  const values = row.extras ?? []
  // Раскрытие старше применения: строка с детьми раскрывается, а не фильтрует.
  const act = expanded === undefined ? row.onSelect : onToggle

  return (
    <tr
      className={cn(
        'border-b border-border/60 last:border-0',
        row.highlight && 'bg-muted',
        // Цель щелчка — вся строка, а не подпись в первой колонке: числа справа
        // такая же часть строки, и промах по ним выглядел бы поломкой. Настоящая
        // кнопка при этом стоит в подписи (ниже) — она держит клавиатуру и имя для
        // скринридера, а обработчик на tr только расширяет цель мыши.
        act && 'cursor-pointer hover:bg-muted/60',
      )}
      onClick={act}
    >
      <td className={cn('py-2.5 pr-6 align-middle', nested && 'py-2')}>
        {/* Вложенная строка — с рельсом слева: без него вопросы страницы читаются
            как продолжение списка страниц. */}
        <div className={cn(nested && 'ml-1.5 border-l pl-4 text-muted-foreground')}>
          {act ? (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 text-left"
              aria-expanded={expanded}
              aria-label={row.actionLabel}
              // Та же фраза подсказкой: щелчок по строке иначе виден только курсором.
              title={row.actionLabel}
              onClick={(e) => {
                // Иначе щелчок по кнопке сработал бы дважды: на ней и на строке.
                e.stopPropagation()
                act()
              }}
            >
              {expanded !== undefined && (
                <ChevronRight
                  className={cn(
                    'size-4 shrink-0 text-muted-foreground transition-transform',
                    expanded && 'rotate-90',
                  )}
                  aria-hidden
                />
              )}
              <span className="min-w-0">{row.label}</span>
            </button>
          ) : (
            row.label
          )}
        </div>
      </td>
      {/* Полоска скрыта на узком экране: на 375 px ей остаётся полсантиметра, и
          вместо величины выходит точка. Числа при этом на месте — они и есть
          содержание, а полоска их только сравнивает. */}
      <td className="hidden w-2/5 py-2.5 align-middle sm:table-cell">
        <div className="h-5 w-full overflow-hidden rounded-sm bg-muted" aria-hidden="true">
          <div className="flex h-full rounded-sm" style={{ width: `${row.share * 100}%` }}>
            <div className="h-full flex-1 bg-chart-1" />
            {/* Часть целого — тот же тон в меньшей светлоте, а не соседний цвет из
                категориального набора (docs/DESIGN-SYSTEM.md, «целое и его часть»). */}
            {lost > 0 && (
              <div
                className="h-full bg-chart-1-soft"
                style={{ width: `${(lost / row.share) * 100}%` }}
              />
            )}
          </div>
        </div>
      </td>
      <td className="py-2.5 pl-4 text-right align-middle font-medium tabular-nums whitespace-nowrap">
        {row.value}
      </td>
      {Array.from({ length: extras }, (_, i) => (
        <td
          key={i}
          className={cn(
            'py-2.5 pl-4 text-right align-middle tabular-nums whitespace-nowrap',
            row.highlight ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {values[i] ?? '—'}
        </td>
      ))}
    </tr>
  )
}

// TOP — сколько строк разбивки видно сразу. Восьмая строка города или браузера
// нужна редко, а список из сотни занимает экран; остальное разворачивается кнопкой.
//
// Кнопка, а не подсказка по наведению: до фазы 30 хвост жил в тултипе сектора
// «Прочее», то есть с клавиатуры был недостижим, а на телефоне — недостижим вовсе.
const TOP = 8

export type BreakdownRow = {
  key: string
  label: React.ReactNode
  visits: number
  submitted: number
}

// Разбивка визитов таблицей: подпись, визиты с долей, конверсия строки.
//
// ТАБЛИЦЕЙ, А НЕ КОЛЬЦОМ. До фазы 30 все шесть разбивок «Визитов» рисовались
// кольцом с легендой — довод был в том, что вопрос ко всем один: «как поделилось».
// Довод верен, но подписи у половины разбивок длинные («yandex-direct / cpc»,
// «Петропавловск-Камчатский»), а легенда рядом с кольцом узкая: на десктопе они
// обрезались до десяти знаков, на телефоне — до одной буквы. Кольцо отвечало на
// вопрос «как поделилось» ценой того, ЧТО именно поделилось.
//
// Доля и ширина полоски считаются от ОДНОЙ базы — суммы визитов разбивки.
export function BreakdownList({ rows, label }: { rows: BreakdownRow[]; label: string }) {
  const [all, setAll] = useState(false)
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Данных нет.</p>

  const total = rows.reduce((sum, r) => sum + r.visits, 0)
  // Строки приходят уже отсортированными по убыванию (сервер сортирует их в SQL,
  // вторым ключом — по подписи, чтобы соседние обновления не переставляли строки
  // местами). Своя сортировка была бы второй копией правила.
  const shown = all ? rows : rows.slice(0, TOP)
  const hidden = rows.length - shown.length

  return (
    <div className="flex flex-col gap-2">
      <BarRows
        columns={{ label, value: 'Визиты', extras: ['Отправили'] }}
        rows={shown.map((r) => ({
          key: r.key,
          label: r.label,
          value: `${r.visits} · ${percentText(r.visits, total)}`,
          share: total > 0 ? r.visits / total : 0,
          extras: [conversionText(r.submitted, r.visits)],
        }))}
      />
      {(hidden > 0 || all) && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll((v) => !v)}>
          {all ? 'Свернуть' : `Показать ещё ${hidden}`}
        </Button>
      )}
    </div>
  )
}

// Несколько разбивок под одним заголовком раздела. Вкладками, а не столбиком
// секций: до этого «Визиты» разворачивались в шесть списков подряд с шестью
// заголовками — полтора экрана прокрутки там, где смотрят один список за раз.
//
// Одна вкладка рисуется БЕЗ переключателя: ряд из единственной кнопки выглядит
// сломанным выбором. Случай не гипотетический — на контуре без справочника гео
// «Откуда приходят» остаётся с одними источниками.
export function BreakdownTabs({
  panels,
}: {
  panels: { value: string; label: string; content: React.ReactNode }[]
}) {
  const first = panels.at(0)
  if (!first) return null
  if (panels.length === 1) return first.content

  return (
    <Tabs defaultValue={first.value} className="gap-4">
      <TabsList variant="line" className="h-auto p-0">
        {panels.map((p) => (
          <TabsTrigger key={p.value} value={p.value} className="px-1.5">
            {p.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {panels.map((p) => (
        <TabsContent key={p.value} value={p.value}>
          {p.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}
