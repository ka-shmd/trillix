import type { ReactNode } from 'react'
import {
  AlignLeft,
  Calendar,
  CheckSquare,
  ShieldCheck,
  ChevronDown,
  CircleDot,
  Hash,
  Image,
  Mail,
  Phone,
  Ruler,
  Pilcrow,
  Heading,
  Heading1,
  Tag,
  Type,
} from 'lucide-react'
import { type BlockType } from '@entities/formSchema'

// Иконка на тип блока — визуальная опора в slash-меню и диалоге добавления блока.
// Ключи покрывают все типы. Отдельный модуль (не рядом с компонентами), чтобы не
// ломать fast-refresh экспортом не-компонента.
export const typeIcons: Record<BlockType, ReactNode> = {
  text: <Pilcrow className="size-4" />,
  short_text: <Type className="size-4" />,
  long_text: <AlignLeft className="size-4" />,
  email: <Mail className="size-4" />,
  phone: <Phone className="size-4" />,
  number: <Hash className="size-4" />,
  scale: <Ruler className="size-4" />,
  single_choice: <CircleDot className="size-4" />,
  dropdown: <ChevronDown className="size-4" />,
  multi_choice: <CheckSquare className="size-4" />,
  date: <Calendar className="size-4" />,
  consent: <ShieldCheck className="size-4" />,
  title: <Type className="size-4" />,
  label: <Tag className="size-4" />,
  heading: <Heading className="size-4" />,
  image: <Image className="size-4" />,
  // Заголовок формы в меню вставки не появляется (он единственный и приколот
  // первой строкой, §3.2 спеки фазы 15), но Record обязан покрывать ВСЕ типы:
  // именно эта полнота и напомнила про него — tsc не дал забыть.
  form_title: <Heading1 className="size-4" />,
}
