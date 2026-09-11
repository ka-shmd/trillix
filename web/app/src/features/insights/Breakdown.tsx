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
}

export function BarRows({ rows, className }: { rows: BarRow[]; className?: string }) {
  return (
    <ul className={cn('flex flex-col gap-1', className)}>
      {rows.map((row) => (
        <li key={row.key} className="relative overflow-hidden rounded-md">
          {/* Заливка цветом ДАННЫХ (--chart-1), а не акцентом: акцент действия в
              кабинете значит «сюда можно нажать», а полоска — величина
              (docs/DESIGN-SYSTEM.md, роли цвета). */}
          <div
            className="absolute inset-y-0 left-0 rounded-md bg-chart-1/15"
            style={{ width: `${row.share * 100}%` }}
            aria-hidden="true"
          />
          <div className="relative flex justify-between gap-4 px-2.5 py-1.5 text-sm">
            <span className="min-w-0 break-words">{row.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {row.count}
              {row.percent !== undefined && ` · ${row.percent} %`}
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
