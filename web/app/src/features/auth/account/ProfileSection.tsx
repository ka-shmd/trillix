import { useRef, useState } from 'react'
import { Camera, ImageUp, Loader2, Trash2 } from 'lucide-react'

import { displayName, type User } from '../../../entities/user'
import { ApiError } from '../../../shared/api/errors'
import { UserAvatar } from '../../../shared/UserAvatar'
import { Section } from '../../../shared/page/Section'
import { useDeleteAvatar, useUpdateProfile, useUploadAvatar } from '../queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// MAX_NAME_LEN зеркалит MaxPersonNameLen из internal/auth/service_account.go.
// Расхождение с сервером даст 422 на форме, которая считает себя валидной.
const MAX_NAME_LEN = 100

// Профиль: фото и имя — то единственное на странице, что видят другие люди.
// Стоит первым по этой же причине: остальные разделы отвечают на вопрос «как я
// вхожу», а не «кто я».
//
// РАЗДЕЛ — СТРОКА С ДЕЙСТВИЕМ, КАК ВСЕ ОСТАЛЬНЫЕ НА ЭТОЙ СТРАНИЦЕ (решение
// владельца 2026-09-08, третий заход). Способы входа, второй фактор и
// устройства собраны одинаково: линия под заголовком, факт строкой, кнопка
// справа, правка в диалоге. Профиль был единственной сырой формой — двумя полями и кнопкой
// «Сохранить» прямо в потоке страницы, — и выглядел чужим при ЛЮБОЙ расстановке
// своих частей: два предыдущих захода переставляли кружок и поля, не трогая
// того, что раздел вообще другого жанра.
//
// Цена размена названа вслух: правка имени стоит теперь двух нажатий вместо
// нуля. Это та же цена, что уже принята у адреса и пароля, и берётся она за то,
// что страница отвечает на все вопросы одинаково.
export function ProfileSection({ user }: { user: User }) {
  const [renaming, setRenaming] = useState(false)
  // Отказ загрузки фото держит РАЗДЕЛ, а не контрол: абзац рисуется под строкой,
  // а мутация живёт внутри неё. Своего `useMutation` у двух компонентов быть не
  // может — у каждого вызова хука своё состояние, и второй про отказ первого не
  // узнал бы никогда.
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const named = user.firstName !== '' || user.lastName !== ''

  return (
    <Section title="Профиль">
      <div className="flex flex-wrap items-center justify-between gap-3 border-t py-4">
        <div className="flex min-w-0 items-center gap-4">
          <AvatarControl user={user} onError={setAvatarError} />
          <div className="min-w-0">
            {/* Имени может не быть вовсе — тогда `displayName` вернёт адрес
                почты, то есть повторит строку под собой. Поэтому пустое имя
                названо пустым. */}
            <p
              className={
                named
                  ? 'truncate text-base font-semibold'
                  : 'truncate text-base text-muted-foreground'
              }
            >
              {named ? displayName(user) : 'Имя не указано'}
            </p>
            {/* Адрес почты стоит ЗДЕСЬ, и это единственное место, где он виден
                (решение владельца 2026-09-08). Своего раздела у него нет: почта
                и есть аккаунт, менять её нельзя ни из кабинета, ни ручкой API —
                механизма смены в продукте не существует. Строка справочная,
                действия при ней нет и быть не должно. */}
            <p className="truncate text-sm text-muted-foreground">{user.email}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>
          {named ? 'Изменить имя' : 'Указать имя'}
        </Button>
      </div>

      {/* Абзац отказа стоит ПОД строкой, а не в ней: строка держит рост от
          кружка, и текст внутри раздвигал бы её на каждой неудачной попытке. */}
      {avatarError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {avatarError}
        </p>
      )}

      <NameDialog user={user} open={renaming} onOpenChange={setRenaming} />
    </Section>
  )
}

// Кадрировать нечего: кружок обрезает картинку по короткой стороне сам
// (object-cover), а сервер только ужимает её до 512 по длинной — редактор кадра
// это отдельная работа со своим контролом.
//
// ВСЕ ДЕЙСТВИЯ ЖИВУТ В САМОМ ФОТО, отдельного значка «⋯» рядом нет (решение
// владельца 2026-09-08). Что он нажимаемый, говорит подложка со значком: она
// проявляется по наведению и по фокусу с клавиатуры.
//
// ⚠ ЧТО ДЕЛАЕТ НАЖАТИЕ, ЗАВИСИТ ОТ ТОГО, ЕСТЬ ЛИ ФОТО. Есть — открывается меню
// «Заменить»/«Удалить»; нет — сразу выбор файла, потому что меню из одного
// пункта это лишнее нажатие на пути к единственному действию.
//
// Ограничения формата и веса в разметке НЕТ намеренно: это граница реализации, и
// человеку она нужна ровно один раз — когда файл не подошёл. Тогда её и говорит
// отказ («Файл больше 5 МБ», «Нужен PNG или JPEG»).
function AvatarControl({
  user,
  onError,
}: {
  user: User
  onError: (message: string | null) => void
}) {
  const upload = useUploadAvatar()
  const remove = useDeleteAvatar()
  const fileRef = useRef<HTMLInputElement>(null)

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // позволить выбрать тот же файл повторно
    if (!file) return
    onError(null)
    upload.mutate(file, { onError: (err) => onError(avatarErrorText(err)) })
  }

  const has = user.avatarKey !== ''
  const busy = upload.isPending || remove.isPending

  const circle = (
    <>
      <UserAvatar person={user} className="size-14 rounded-full text-lg" />
      {/* Подложка лежит поверх кружка ВСЕГДА, но видна по наведению и с
          клавиатуры — иначе нажимаемость картинки узнаётся только случайным
          кликом. На время запроса она видна сама и держит спиннер: вертеть его
          сбоку значило бы двигать содержимое строки на каждой загрузке. */}
      <span
        aria-hidden
        className={`absolute inset-0 flex items-center justify-center rounded-full bg-foreground/55 text-background transition-opacity ${
          busy ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
        }`}
      >
        {busy ? <Loader2 className="size-5 animate-spin" /> : <Camera className="size-5" />}
      </span>
    </>
  )

  const circleClass =
    'group relative shrink-0 rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default'

  return (
    <>
      {/* Нативный файловый диалог — тот случай, когда системный контрол лучше
          своего (web/CLAUDE.md); сам input спрятан, его открывают кружок и меню. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={onFile}
      />

      {has ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={busy}
              aria-label="Действия с фото"
              className={circleClass}
            >
              {circle}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
              <ImageUp className="size-4" />
              Заменить фото
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                onError(null)
                remove.mutate(undefined, { onError: (err) => onError(avatarErrorText(err)) })
              }}
            >
              <Trash2 className="size-4" />
              Удалить фото
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <button
          type="button"
          disabled={busy}
          aria-label="Загрузить фото"
          className={circleClass}
          onClick={() => fileRef.current?.click()}
        >
          {circle}
        </button>
      )}
    </>
  )
}

function avatarErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'payload_too_large':
        return 'Файл больше 5 МБ.'
      case 'validation_failed':
        return 'Не похоже на картинку. Нужен PNG или JPEG.'
      case 'rate_limited':
        return 'Слишком часто. Подождите минуту и попробуйте снова.'
    }
  }
  return 'Не удалось сохранить фото. Попробуйте ещё раз.'
}

function NameDialog({
  user,
  open,
  onOpenChange,
}: {
  user: User
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const update = useUpdateProfile()
  const [firstName, setFirstName] = useState(user.firstName)
  const [lastName, setLastName] = useState(user.lastName)

  const tooLong = firstName.length > MAX_NAME_LEN || lastName.length > MAX_NAME_LEN
  const dirty = firstName !== user.firstName || lastName !== user.lastName

  // Закрытие возвращает поля к серверным значениям: следующее открытие должно
  // показывать то, что есть, а не брошенный черновик прошлой попытки.
  function close() {
    setFirstName(user.firstName)
    setLastName(user.lastName)
    update.reset()
    onOpenChange(false)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (tooLong || !dirty) return
    update.mutate({ firstName, lastName }, { onSuccess: () => onOpenChange(false) })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Имя и фамилия</DialogTitle>
          <DialogDescription>
            Так вас будут звать в кабинете и в списках участников. Можно оставить пустым — тогда вас
            покажет адрес почты.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="first-name" className="mb-2 block">
              Имя
            </Label>
            <Input
              id="first-name"
              value={firstName}
              maxLength={MAX_NAME_LEN}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="Иван"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="last-name" className="mb-2 block">
              Фамилия
            </Label>
            <Input
              id="last-name"
              value={lastName}
              maxLength={MAX_NAME_LEN}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Петров"
            />
          </div>

          {update.isError && (
            <p role="alert" className="text-sm text-destructive">
              Не удалось сохранить. Попробуйте ещё раз.
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Отмена
            </Button>
            <Button type="submit" disabled={!dirty || tooLong || update.isPending}>
              {update.isPending ? 'Сохраняем…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
