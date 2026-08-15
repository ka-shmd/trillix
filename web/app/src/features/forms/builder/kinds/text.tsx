import { Pilcrow } from 'lucide-react'

import { type EditorKind } from './contract'

export const text: EditorKind = {
  menu: { question: false, field: false, layout: true },
  label: 'Текст',
  description: 'Статический абзац — пояснение или инструкция. Не запрашивает ответ.',
  icon: <Pilcrow className="size-4" />,
  // Единственный тип, у которого имя строки ПОЗИЦИОННОЕ (name: null): пустой абзац
  // значит разное в разных местах документа — начало формы зовёт добавить вопрос, абзац
  // внутри вопроса предлагает описание. Подсказку такому типу показываем только под
  // фокусом: пустая строка у него законна, и мигать именем для скринридера нельзя.
  row: {
    surface: 'text',
    name: null,
    className: 'rf-text',
    lineH: 'h-6',
    bold: false,
    placeholderOnFocusOnly: true,
  },
}
