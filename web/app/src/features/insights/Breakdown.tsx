import { useState } from 'react'

import { conversionText, percentText } from './metrics'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

// Строка-полоска — ЕДИНСТВЕННАЯ форма «подпись, величина, доля» во всей аналитике:
// распределения сводки, разбивки визитов, шаги воронки. Заводить свою разметку
// полоски запрещено: три почти одинаковых вида одного и того же читаются как
// небрежность, а не как разница смысла.
//
// ГЕОМЕТРИЯ: подпись — полоска — числа, тремя колонками в одну строку.
//
// Полоска СПЛОШНАЯ и стоит в своей колонке. Раньше она была заливкой ПОД текстом,
// и это стоило двух вещей сразу. Во-первых, цвета: под буквами заливка обязана
// оставаться бледной, иначе текст на ней не читается, — поэтому величина рисовалась
// пятном в четверть насыщенности и терялась рядом с обычной подсветкой строки.
// Во-вторых, длины: подпись тянула строку, и полоска мерялась не от одной базы у
// соседних списков, а от ширины самого длинного варианта ответа.
//
// В своей колонке полоска берёт полный тон --chart-1, а подпись остаётся чёрной на
// белом. Это и есть ответ на «вяло и бледно» (решение владельца 2026-09-19): цвет
// достался данным, а не фону под буквами.

export type BarRow = {
  key: string
  label: React.ReactNode
  // Правая колонка — готовый текст: «613 · 30 %», «4127 · 52 %». Собирает его
  // вызывающий, потому что доля у экранов считается от разных баз, и подставлять
  // её здесь значило бы навязать одну базу всем.
  value: React.ReactNode
  // Доля заливки 0..1. База — забота вызывающего (у распределения это ответившие,
  // у разбивки визитов — сумма разбивки, у воронки — визиты формы).
  share: number
  // Хвост заливки, нарисованный светлее: у шага воронки это ушедшие. Доля от той
  // же базы, что share, и всегда его часть.
  lost?: number
  // Вторая колонка чисел — конверсия строки у разбивок визитов. Своей колонкой, а
  // не припиской: числа разной природы, и слипшись они читались бы одним составным.
  extra?: React.ReactNode
  // Строка под полоской: потеря у шага воронки, время на странице.
  note?: React.ReactNode
  // Подложка строки: худший шаг воронки. Не цвет состояния — это место на графике,
  // а не отказ системы (docs/DESIGN-SYSTEM.md, роли цвета).
  highlight?: boolean
}

// extraLabel — шапка колонки второго числа. Без подписи «26 %» рядом с «2051 · 26 %»
// не отличить от доли, а колонок с процентами в строке две.
export function BarRows({
  rows,
  extraLabel,
  className,
}: {
  rows: BarRow[]
  extraLabel?: string
  className?: string
}) {
  return (
    <ul className={cn('flex flex-col gap-0.5', className)}>
      {extraLabel && (
        <li className="hidden justify-end gap-4 px-2 text-sm text-muted-foreground sm:flex">
          <span className="w-20 shrink-0 text-right">{extraLabel}</span>
        </li>
      )}
      {rows.map((row) => (
        <Row key={row.key} row={row} />
      ))}
    </ul>
  )
}

// Колонки: подпись — полоска — числа. На узком экране грид выключается и строка
// складывается столбиком: полоска во всю ширину под подписью.
//
// Колонка подписи — fit-content с потолком: она сжимается до самой длинной подписи
// СПИСКА и не шире 15rem. Фиксированная ширина обслуживала бы худший случай всегда,
// и распределение шкалы («0», «1», … «10») отдавало бы восемь пустых сантиметров
// перед полоской.
const GRID = 'sm:grid-cols-[fit-content(15rem)_minmax(0,1fr)_max-content] sm:items-center'

function Row({ row }: { row: BarRow }) {
  const lost = Math.min(row.lost ?? 0, row.share)
  return (
    <li
      className={cn(
        '-mx-2 grid gap-x-4 gap-y-1 rounded-md px-2 py-1.5',
        GRID,
        row.highlight && 'bg-muted',
      )}
    >
      <span className="text-sm">{row.label}</span>

      <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div className="flex h-full rounded-full" style={{ width: `${row.share * 100}%` }}>
          <div className="h-full flex-1 rounded-l-full bg-chart-1" />
          {/* Часть целого — тот же тон в меньшей светлоте, а не соседний цвет из
              категориального набора (docs/DESIGN-SYSTEM.md, «целое и его часть»). */}
          {lost > 0 && (
            <div
              className="h-full rounded-r-full bg-chart-1-soft"
              style={{ width: `${(lost / row.share) * 100}%` }}
            />
          )}
        </div>
      </div>

      <span className="flex shrink-0 items-baseline gap-4 text-sm tabular-nums">
        <span className="font-medium">{row.value}</span>
        {row.extra !== undefined && (
          <span className="w-20 shrink-0 text-right text-muted-foreground">{row.extra}</span>
        )}
      </span>

      {row.note && (
        <p
          className={cn(
            'text-sm sm:col-span-2 sm:col-start-2',
            row.highlight ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {row.note}
        </p>
      )}
    </li>
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

// Разбивка визитов списком: подпись, визиты с долей, конверсия строки.
//
// СПИСКОМ, А НЕ КОЛЬЦОМ. До фазы 30 все шесть разбивок «Визитов» рисовались
// кольцом с легендой — довод был в том, что вопрос ко всем один: «как поделилось».
// Довод верен, но подписи у половины разбивок длинные («yandex-direct / cpc»,
// «Петропавловск-Камчатский»), а легенда рядом с кольцом узкая: на десктопе они
// обрезались до десяти знаков, на телефоне — до одной буквы. Кольцо отвечало на
// вопрос «как поделилось» ценой того, ЧТО именно поделилось.
//
// Доля и ширина полоски считаются от ОДНОЙ базы — суммы визитов разбивки.
export function BreakdownList({ rows }: { rows: BreakdownRow[] }) {
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
        extraLabel="Отправили"
        rows={shown.map((r) => ({
          key: r.key,
          label: r.label,
          value: `${r.visits} · ${percentText(r.visits, total)}`,
          share: total > 0 ? r.visits / total : 0,
          extra: conversionText(r.submitted, r.visits),
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
