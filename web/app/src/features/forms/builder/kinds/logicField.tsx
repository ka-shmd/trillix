import { type Block } from '@entities/formSchema'

import { LogicBlockEditor } from '../logic/LogicBlockEditor'

// Вид блока условной логики на полотне. Респондент его не видит никогда — он видит
// ПОСЛЕДСТВИЕ: вопрос показан или спрятан, кнопки нет, страница пропущена. Поэтому вид
// живёт здесь, в редакторе, а не в общих @fields: в рендерер он не едет и бюджета не
// занимает (тот же довод, что у разрыва страницы).
//
// Отдельным файлом, как PageBreakField и DateControl: файл типа обязан экспортировать
// только описание типа, иначе fast refresh перестаёт работать на всём модуле.
export function LogicField({ block }: { block: Block }) {
  return <LogicBlockEditor block={block} />
}
