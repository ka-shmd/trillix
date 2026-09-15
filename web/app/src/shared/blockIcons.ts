import {
  AlignLeft,
  Calendar,
  CalendarClock,
  CaseSensitive,
  CheckSquare,
  ChevronDown,
  CircleDot,
  GitBranch,
  Hash,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Mail,
  Paperclip,
  Phone,
  Pilcrow,
  Ruler,
  SeparatorHorizontal,
  ShieldCheck,
  Star,
  Tag,
  Tags,
  Type,
  type LucideIcon,
} from 'lucide-react'

import { type BlockType } from '@entities/formSchema'

// Глиф типа блока — лицо типа во всём кабинете: slash-меню и диалог добавления, правый
// угол поля на полотне, список вопросов в условной логике, шапка колонки в таблице
// ответов. Тип обязан выглядеть одинаково везде, где о нём говорят.
//
// ЖИВЁТ В SHARED, А НЕ В РЕЕСТРЕ РЕДАКТОРА, по двум причинам. Первая — слои: глиф
// спрашивают и полотно (`features/forms`), и таблица ответов (`features/submissions`), а
// импорт одной фичи из другой запрещён (web/CLAUDE.md). Вторая — цикл импортов: словарь,
// собранный ИЗ ФАЙЛОВ ТИПОВ, на инициализации модуля ещё пуст («Cannot convert undefined
// or null to object»), потому что глиф поля нужен `kinds/fieldWrap`, fieldWrap — контролу
// даты, контрол — файлу типа, а файлы типов собираются в тот самый реестр. Здесь
// зависимость одна, lucide, и цикла нет вовсе.
//
// НЕ в `@entities`: тот каталог общий с рендерером, а лишний импорт lucide в публичной
// форме — это её бюджет в 60 КиБ gzip.
//
// Компонент, который его рисует, лежит ОТДЕЛЬНО (`BlockTypeIcon.tsx`): не-компонентный
// экспорт из файла компонента ломает fast-refresh.
//
// Record ИСЧЕРПЫВАЮЩИЙ, без Partial и без фолбэка: новый тип блока без глифа не
// компилируется — тем же правилом, что три слоя реестра типов (docs/EDITOR.md §16).
// Глифы обязаны быть РАЗНЫМИ (сторож — blockIcons.test.ts): там, где типы стоят рядом
// списком, глиф единственное, что отличает строку от соседней.
export const BLOCK_ICONS: Record<BlockType, LucideIcon> = {
  short_text: CaseSensitive,
  long_text: AlignLeft,
  email: Mail,
  phone: Phone,
  number: Hash,
  scale: Ruler,
  rating: Star,
  single_choice: CircleDot,
  dropdown: ChevronDown,
  multi_choice: CheckSquare,
  multi_select: Tags,
  date: Calendar,
  consent: ShieldCheck,
  file: Paperclip,
  slot: CalendarClock,
  title: Type,
  label: Tag,
  // Общий «Heading», а не Heading1: тот занят заголовком ФОРМЫ.
  heading: Heading,
  heading_2: Heading2,
  heading_3: Heading3,
  text: Pilcrow,
  image: Image,
  page_break: SeparatorHorizontal,
  logic: GitBranch,
  form_title: Heading1,
}
