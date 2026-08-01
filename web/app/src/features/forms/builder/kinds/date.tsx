import { Calendar } from 'lucide-react'

import { type EditorKind } from './contract'
import { DateControl } from './dateControl'

export const date: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Дата',
  description: 'Выбор даты.',
  icon: <Calendar className="size-4" />,
  // Объектная остановка, а не инпут: плейсхолдера у поля даты нет (браузер рисует свой
  // формат), править внутри строки нечего — каретка встаёт НА поле.
  row: { surface: 'object', lineH: 'h-6', Control: DateControl, hint: 'object' },
}
