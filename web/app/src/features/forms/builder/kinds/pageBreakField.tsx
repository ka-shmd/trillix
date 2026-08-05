import { type Block } from '@entities/formSchema'
import { pageNumbers } from '@fields/groups'

import { useBuilderStore } from '../storeContext'

// Вид разрыва страницы на полотне (фаза 19). Респондент его не видит никогда — он видит
// ПОСЛЕДСТВИЕ: форма разбита на шаги. Поэтому вид живёт здесь, в редакторе, а не в общих
// @fields: в рендерер он не едет и бюджета не занимает.
//
// Отдельным файлом, как DateControl и ImageField: файл типа обязан экспортировать только
// описание типа, иначе fast refresh перестаёт работать на всём модуле.
//
// Номер страницы считается ТЕМ ЖЕ разбиением, что режет форму респонденту (pageNumbers
// поверх splitPages), а не собственным счётом разрывов: собственный счёт разошёлся бы с
// показом на первом же инертном разрыве, и автор увидел бы на полотне страницу, которой у
// респондента нет. Инертный разрыв (два подряд, разрыв в конце, разрыв до всего
// содержимого) остаётся видимым и подписывается без номера — он законное состояние
// черновика, за которым автор ещё допишет блоки.
export function PageBreakField({ block }: { block: Block }) {
  const opens = useBuilderStore((s) => pageNumbers(s.blocks).get(block.id))
  return (
    <div className="flex select-none items-center gap-3 py-1">
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span
        className={`text-xs uppercase tracking-wide ${opens === undefined ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}
      >
        {opens === undefined ? 'Разрыв страницы' : `Страница ${opens}`}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}
