import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'

import { isHttpUrl, MAX_REDIRECT_URL_LEN, MAX_THANK_YOU_TEXT_LEN } from '@entities/formSchema'

import { useBuilderStore } from './storeContext'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

// FormSettings — страница настроек формы: то, чего на полотне не видно. Полотно
// остаётся документом из блоков (плюс кнопка отправки — её респондент видит, и
// правится она на месте, WYSIWYG). Открывается иконкой в шапке вместо полотна —
// тем же переключателем Mode, что и превью (BuilderScreen).
//
// Сохранение здесь ЯВНОЕ, в отличие от полотна с его автосейвом (решение
// владельца): настройки везде сохраняют кнопкой, и молчаливый автосейв ломал бы
// привычный флоу — человек не понимает, сохранилось ли. Поэтому поля живут в
// локальном черновике, а «Сохранить» разом коммитит их в стор (один шаг undo) и
// тут же уносит на сервер, без дебаунса.
export function FormSettings({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const thankYouText = useBuilderStore((s) => s.thankYouText)
  const redirectUrl = useBuilderStore((s) => s.redirectUrl)
  const setAfterSubmit = useBuilderStore((s) => s.setAfterSubmit)

  const [draft, setDraft] = useState({ thankYouText, redirectUrl })
  // Стор — источник истины: undo/redo и загрузка формы меняют его мимо этой
  // страницы, и черновик обязан догнать. Сверка в рендере, а не эффектом: эффект
  // здесь дал бы лишний каскадный рендер (react-hooks/set-state-in-effect).
  const [synced, setSynced] = useState({ thankYouText, redirectUrl })
  if (synced.thankYouText !== thankYouText || synced.redirectUrl !== redirectUrl) {
    setSynced({ thankYouText, redirectUrl })
    setDraft({ thankYouText, redirectUrl })
  }

  // Диалог-страховка: уход с несохранёнными правками должен быть осознанным.
  const [confirmOpen, setConfirmOpen] = useState(false)

  const trimmedUrl = draft.redirectUrl.trim()
  const urlInvalid = trimmedUrl !== '' && !isHttpUrl(trimmedUrl)
  const dirty = draft.thankYouText !== thankYouText || trimmedUrl !== redirectUrl

  function save() {
    if (urlInvalid) return
    // В стор уходит уже подчищенный URL — именно он поедет в схему.
    setAfterSubmit({ thankYouText: draft.thankYouText, redirectUrl: trimmedUrl })
    onSaved()
  }

  function back() {
    if (dirty) {
      setConfirmOpen(true)
      return
    }
    onBack()
  }

  return (
    <section aria-label="Настройки формы" className="mx-auto max-w-2xl px-5 pb-16 pt-10 sm:px-8">
      <Button variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" onClick={back}>
        <ArrowLeft className="size-4" /> Назад к редактору
      </Button>

      <h1 className="mt-4 text-xl font-medium">Настройки формы</h1>

      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-medium">После отправки</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Что респондент увидит, когда отправит ответ.
        </p>

        <Label htmlFor="thank-you-text" className="mt-4 block text-sm font-medium">
          Текст благодарности
        </Label>
        <Textarea
          id="thank-you-text"
          value={draft.thankYouText}
          placeholder="Спасибо! Ваш ответ отправлен."
          maxLength={MAX_THANK_YOU_TEXT_LEN}
          onChange={(e) => setDraft((d) => ({ ...d, thankYouText: e.target.value }))}
          className="mt-1.5"
        />

        <Label htmlFor="redirect-url" className="mt-4 block text-sm font-medium">
          Ссылка перехода <span className="text-muted-foreground">(необязательно)</span>
        </Label>
        <Input
          id="redirect-url"
          type="url"
          inputMode="url"
          value={draft.redirectUrl}
          placeholder="https://example.com/спасибо"
          maxLength={MAX_REDIRECT_URL_LEN}
          aria-invalid={urlInvalid}
          aria-describedby="redirect-url-hint"
          onChange={(e) => setDraft((d) => ({ ...d, redirectUrl: e.target.value }))}
          className="mt-1.5"
        />
        <p
          id="redirect-url-hint"
          className={`mt-1.5 text-xs ${urlInvalid ? 'text-destructive' : 'text-muted-foreground'}`}
          role={urlInvalid ? 'alert' : undefined}
        >
          {urlInvalid
            ? 'Ссылка должна начинаться с http:// или https://'
            : trimmedUrl === ''
              ? 'Оставьте пустым, чтобы респондент остался на экране благодарности.'
              : 'Покажем текст благодарности и через пару секунд переведём по ссылке.'}
        </p>
      </section>

      <div className="mt-8 flex items-center gap-3 border-t pt-6">
        <Button onClick={save} disabled={!dirty || urlInvalid}>
          Сохранить
        </Button>
        <span className="text-xs text-muted-foreground" role="status">
          {urlInvalid
            ? 'Проверьте ссылку'
            : dirty
              ? 'Есть несохранённые изменения'
              : 'Всё сохранено'}
        </span>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Есть несохранённые изменения</AlertDialogTitle>
            <AlertDialogDescription>
              Настройки формы изменены, но не сохранены. Если уйти сейчас, правки пропадут.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Остаться</AlertDialogCancel>
            <AlertDialogAction onClick={onBack}>Уйти без сохранения</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
