import { mediaSrc } from '@fields/media'

import { initials } from '../entities/user'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

// Кружок человека: картинка, если аватар загружен, иначе инициалы (сайдбар,
// настройки, список участников). Radix показывает fallback не только при пустом
// ключе, но и когда картинка не загрузилась — снесённый из бакета объект даёт
// инициалы, а не сломанную иконку.
//
// Принимает поля, а не User: у участника пространства своя схема (entities/member),
// а кружок у них один.
export interface UserAvatarProps {
  person: { firstName: string; lastName: string; email: string; avatarKey: string }
  className?: string
}

export function UserAvatar({ person, className }: UserAvatarProps) {
  return (
    <Avatar className={cn('rounded-md', className)}>
      {person.avatarKey !== '' && (
        <AvatarImage src={mediaSrc(person.avatarKey)} alt="" draggable={false} />
      )}
      <AvatarFallback className="rounded-md bg-sidebar-primary font-semibold text-sidebar-primary-foreground">
        {initials(person)}
      </AvatarFallback>
    </Avatar>
  )
}
