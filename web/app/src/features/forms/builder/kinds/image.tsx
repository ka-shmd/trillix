import { Image } from 'lucide-react'

import { type EditorKind } from './contract'
import { ImageField } from '../ImageField'

export const image: EditorKind = {
  menu: { question: false, field: false, layout: true },
  label: 'Картинка',
  description: 'Изображение на полотне формы (PNG или JPEG). Не запрашивает ответ.',
  icon: <Image className="size-4" />,
  // Объектная остановка: своего текста у картинки нет, каретка встаёт на неё саму.
  row: { surface: 'object', lineH: 'h-6', Control: ImageField, hint: 'image' },
}
