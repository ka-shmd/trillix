import { ShieldCheck } from 'lucide-react'

import { type EditorKind } from './contract'

export const consent: EditorKind = {
  menu: { question: true, field: true, layout: false },
  label: 'Согласие',
  description: 'Галочка согласия со своим текстом — обработка данных, оферта, рассылка.',
  icon: <ShieldCheck className="size-4" />,
  // Согласие создаётся обязательным: это дефолт, а не правило типа (решение владельца) —
  // владелец может выключить, если это маркетинг-opt-in.
  defaults: { required: true },
  // Единственный отвечаемый тип с текстовой строкой: текст согласия и есть строка
  // вопроса, галочка стоит слева от него, отдельного превью-контрола нет.
  row: {
    surface: 'text',
    name: 'Текст согласия',
    className: 'rf-consent',
    lineH: 'h-6',
    bold: false,
    mark: 'check',
  },
}
