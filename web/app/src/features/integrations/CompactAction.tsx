import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'

// CompactAction — компактное действие со значком: обслуживание того, что на
// экране уже есть, а не следующий вопрос анкеты. Набрано мельче подписи поля и
// приглушено цветом, поэтому за очередь взгляда с полями не спорит.
//
// Вид взят у «Изменить» в строке формы (features/forms/FormRow.tsx) — это уже
// сложившийся в кабинете облик такого действия: ghost, поэтому на наведении
// подложка, а не подчёркивание. Второй вариант одного и того же читался бы как
// другой класс кнопки, поэтому на всю фичу интеграций он один — и у действий над
// аккаунтом Google, и у предложений подписи и своих заголовков вебхука.
export function CompactAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-muted-foreground"
      onClick={onClick}
    >
      <Icon className="size-3.5" />
      {label}
    </Button>
  )
}
