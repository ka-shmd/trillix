import { type Block } from '@entities/formSchema'

import { type Answer } from '../answer'

// Контракт контрола типа поля — как один тип выглядит у респондента (фаза 16, этап
// 16.1б). Один файл на тип, тот же интерфейс у всех, исчерпывающий Record в index.ts.
//
// Слой ВИДА, и он общий с рендерером: Tailwind и shadcn здесь запрещены (бюджет 95 КиБ
// gzip), вид задают классы rf-* из fields.css. Поведение типа на полотне редактора живёт
// не здесь, а в builder/kinds/* — это другой слой и другое приложение.

export type ControlProps = {
  block: Block
  // aria-label контрола: подпись группы, иначе плейсхолдер, иначе фолбэк. Считает
  // BlockField — только он знает контекст группы.
  label: string
  value?: Answer
  onChange?: (next: Answer) => void
  // Превью билдера отдаёт disabled=true: контролы видны, но не редактируются.
  disabled: boolean
  // ЧИТАЕМЫЙ РЕЖИМ (печатная страница ответа). Сильнее disabled и решает другую
  // задачу: неинтерактивный контрол всё ещё остаётся контролом браузера, а на
  // бумаге он обязан ПОКАЗАТЬ ВЕСЬ ответ. Однострочный input чужой ответ обрезает
  // по своей ширине молча, textarea — по своей высоте, и увидеть потерю по PDF
  // нельзя. Контролы, которые и так показывают состояние целиком (выбор, шкала,
  // согласие), флаг игнорируют — им переключаться не во что.
  readOnly?: boolean
  invalid: boolean
  errorId?: string
  onBlur?: () => void
}

// Контрол — обычный компонент, а не функция-рендер: так у него законно появятся хуки,
// когда понадобятся (загрузка файла — первый кандидат), и React видит его отдельным
// узлом дерева.
export type Control = (p: ControlProps) => React.ReactNode

// Значение текстового контрола. Пустая строка вместо undefined обязательна: иначе React
// переключает input между controlled и uncontrolled.
export const textValue = (value?: Answer): string => (typeof value === 'string' ? value : '')

// Плейсхолдер из настроек блока (автор задаёт его в билдере); пусто → undefined, то есть
// атрибута нет вовсе.
export const placeholderOf = (block: Block): string | undefined =>
  block.settings?.placeholder?.trim() || undefined

// Общие a11y-атрибуты контрола: пометка невалидности, связь с сообщением об ошибке и
// проверка по потере фокуса. undefined убирает атрибут в валидном состоянии.
export const invalidAttrs = (p: ControlProps) => ({
  'aria-invalid': p.invalid || undefined,
  'aria-describedby': p.invalid ? p.errorId : undefined,
  onBlur: p.onBlur,
})
