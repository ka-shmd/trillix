import { Paperclip } from 'lucide-react'

import { type EditorKind } from './contract'
import { FileControl } from './fileControl'

export const file: EditorKind = {
  // Разделы те же, что у любого отвечаемого типа: их состав — инвариант реестра
  // («вопросы» и «поля» покрывают ровно отвечаемые), и держит его registry.test.ts.
  menu: { question: true, field: true, layout: false },
  label: 'Файл',
  description: 'Респондент прикладывает файл — документ, картинку или таблицу.',
  icon: <Paperclip className="size-4" />,
  // Объектная остановка: своего текста у поля нет, править внутри строки нечего —
  // каретка встаёт на саму зону, как у даты и шкалы.
  row: { surface: 'object', Control: FileControl, hint: 'object', lineH: 'h-6' },
}
