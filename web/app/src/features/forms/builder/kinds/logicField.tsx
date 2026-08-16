import { type Block } from '@entities/formSchema'

// Вид блока условной логики на полотне. Респондент его не видит никогда — он видит
// ПОСЛЕДСТВИЕ: вопрос показан или спрятан, кнопки нет, страница пропущена. Поэтому вид
// живёт здесь, в редакторе, а не в общих @fields: в рендерер он не едет и бюджета не
// занимает (тот же довод, что у разрыва страницы).
//
// Отдельным файлом, как PageBreakField и DateControl: файл типа обязан экспортировать
// только описание типа, иначе fast refresh перестаёт работать на всём модуле.
//
// СЕЙЧАС ЭТО ОБОЛОЧКА: два яруса «Когда» и «Тогда» с состоянием «не задано». Селекты
// источника, оператора, значения и действия приезжают следующим шагом работы вместе с
// вычислителем — до него правило всё равно ни на что не влияет.
export function LogicField({ block }: { block: Block }) {
  const when = block.logic?.when
  const actions = block.logic?.then ?? []
  return (
    <div className="flex select-none flex-col gap-1 py-1 text-sm">
      <LogicLine label="Когда" filled={when !== undefined} empty="условие не задано" />
      <LogicLine
        label="Тогда"
        filled={actions.length > 0}
        empty="действие не выбрано"
        filledText={`действий: ${actions.length}`}
      />
    </div>
  )
}

function LogicLine({
  label,
  filled,
  empty,
  filledText = 'условие задано',
}: {
  label: string
  filled: boolean
  empty: string
  filledText?: string
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-14 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={filled ? 'text-foreground' : 'text-muted-foreground/60'}>
        {filled ? filledText : empty}
      </span>
    </div>
  )
}
