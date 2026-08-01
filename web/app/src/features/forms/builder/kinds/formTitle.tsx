import { Heading1 } from 'lucide-react'

import { type EditorKind } from './contract'

export const formTitle: EditorKind = {
  // В меню вставки не появляется: он единственный и приколот первой строкой документа.
  menu: { question: false, field: false, layout: false },
  label: 'Заголовок формы',
  description: 'Первая строка документа — <h1> у респондента. Вставке не подлежит.',
  icon: <Heading1 className="size-4" />,
  // У заголовка формы СВОЯ строка (FormTitleRow): он рисуется вне потока вопросов, и
  // BlockRow его не получает вовсе. null — объявленный факт, а не пропуск.
  row: null,
}
