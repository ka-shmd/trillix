import { useState } from 'react'

import { conversionText, percentOf } from './metrics'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

// Строка-полоска — единственная форма «подпись, число, доля» во всей аналитике:
// сводка, разбивки визитов и списки внутри вкладок берут её отсюда. Заводить свою
// разметку полоски запрещено — три почти одинаковых вида одного и того же читаются
// как небрежность, а не как разница смысла.
//
// Заливка ПОД текстом, а не отдельным треком: строка занимает одну высоту вместо
// двух, и на вкладке с шестью списками это разница в пол-экрана прокрутки.

export type BarRow = {
  key: string
  label: React.ReactNode
  count: number
  // Доля 0..1 — только ширина заливки. Базу выбирает вызывающий, и она у экранов
  // разная: у сводки это «сколько человек вопрос видели», у разбивок визитов —
  // максимум списка (задача такого списка — сравнить строки между собой, а не
  // назвать величину). Считать её здесь значило бы навязать одну базу обоим.
  share: number
  // Процент рядом с числом — необязателен ровно потому, что доля от максимума
  // процентом не является: печатать «100 %» у самой длинной строки списка
  // устройств было бы неправдой.
  percent?: number
  // Второе число строки своей колонкой — конверсия у разбивок визитов. Своей, а не
  // припиской к первому: числа разной природы, и слипшись в одну строку они
  // читались бы как одно составное значение.
  extra?: React.ReactNode
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
    <ul className={cn('flex flex-col gap-1', className)}>
      {extraLabel && (
        <li className="flex justify-end gap-4 px-2.5 text-sm text-muted-foreground">
          <span className="w-24 shrink-0 text-right">{extraLabel}</span>
        </li>
      )}
      {rows.map((row) => (
        <li key={row.key} className="relative overflow-hidden rounded-md">
          {/* Заливка цветом ДАННЫХ (--chart-1), а не акцентом: акцент действия в
              кабинете значит «сюда можно нажать», а полоска — величина
              (docs/DESIGN-SYSTEM.md, роли цвета).

              Насыщенность 25 %, а не 15: на 15 полоска была светлее подложки
              наведения, и величина читалась как подсветка строки под курсором. */}
          <div
            className="absolute inset-y-0 left-0 rounded-md bg-chart-1/25"
            style={{ width: `${row.share * 100}%` }}
            aria-hidden="true"
          />
          <div className="relative flex justify-between gap-4 px-2.5 py-1.5 text-sm">
            <span className="min-w-0 break-words">{row.label}</span>
            <span className="flex shrink-0 gap-4 tabular-nums text-muted-foreground">
              <span>
                {row.count}
                {row.percent !== undefined && ` · ${row.percent} %`}
              </span>
              {row.extra !== undefined && (
                <span className="w-24 shrink-0 text-right">{row.extra}</span>
              )}
            </span>
          </div>
        </li>
      ))}
    </ul>
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
// Доля и ширина полоски считаются от ОДНОЙ базы — суммы визитов разбивки. База по
// максимуму строки (как у списков, где процента нет) сделала бы первую строку
// во всю ширину при её настоящих 30 %.
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
          count: r.visits,
          share: total > 0 ? r.visits / total : 0,
          percent: percentOf(r.visits, total),
          extra: conversionText(r.submitted, r.visits),
        }))}
      />
      {(hidden > 0 || all) && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Свернуть' : `Показать ещё ${hidden}`}
        </Button>
      )}
    </div>
  )
}
