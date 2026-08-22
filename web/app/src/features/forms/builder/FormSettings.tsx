import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'

import { isHttpUrl, MAX_REDIRECT_URL_LEN, MAX_THANK_YOU_TEXT_LEN } from '@entities/formSchema'
import { MAX_CLOSED_MESSAGE_LEN, type FormDetail } from '../../../entities/form'
import { useUpdateCloseSettings, useUpdateNotifyOnSubmission } from '../queries'

import { useBuilderStore } from './storeContext'
import { type FormRef } from './useAutosave'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

// FormSettings — страница настроек формы: то, чего на полотне не видно. Полотно
// остаётся документом из блоков (плюс кнопка отправки — её респондент видит, и
// правится она на месте, WYSIWYG). Открывается иконкой в шапке вместо полотна —
// тем же переключателем Mode, что и превью (BuilderScreen).
//
// Две секции с РАЗНЫМ источником истины: «После отправки» — поля схемы (стор
// билдера, сохраняется вместе со схемой через saveNow); «Закрытие формы» — живые
// колонки forms (деталь из Query, сохраняется своей мутацией closeSettings, схемы не
// касается). Сохранение везде ЯВНОЕ, кнопкой (решение владельца): молчаливый автосейв
// ломал бы привычный флоу — человек не понимает, сохранилось ли. Уход с
// несохранёнными правками любой секции стережёт диалог.
// ensureForm — адрес формы на сервере, добытый по надобности. Секция «После отправки»
// в нём не нуждается (она правит стор, а форму заведёт автосейв), а вот «Закрытие» и
// письма — живые колонки: их PATCH адресует форму по id, которого у нового черновика
// ещё нет (ленивое создание, features/forms/draft.ts).
// Отказ ensureForm значит одно: форму, которой ещё не было, не удалось завести.
// Ошибки самих настроек показывают их собственные секции.
const CREATE_FAILED = 'Не удалось создать форму. Попробуйте ещё раз.'

export function FormSettings({
  detail,
  ensureForm,
  onBack,
  onSaved,
}: {
  detail: FormDetail
  ensureForm: () => Promise<FormRef>
  onBack: () => void
  onSaved: () => void
}) {
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

  // Черновик секции закрытия и его синхронизация с деталью (мутация патчит кэш —
  // черновик догоняет по тому же приёму сверки-в-рендере, что и «После отправки»).
  const closeFromDetail = () => ({
    closeLocal: isoToLocalInput(detail.closeAt),
    limit: detail.responseLimit === null ? '' : String(detail.responseLimit),
    message: detail.closedMessage ?? '',
  })
  const [closeDraft, setCloseDraft] = useState(closeFromDetail)
  const [closeSynced, setCloseSynced] = useState({
    closeAt: detail.closeAt,
    responseLimit: detail.responseLimit,
    closedMessage: detail.closedMessage,
  })
  if (
    closeSynced.closeAt !== detail.closeAt ||
    closeSynced.responseLimit !== detail.responseLimit ||
    closeSynced.closedMessage !== detail.closedMessage
  ) {
    setCloseSynced({
      closeAt: detail.closeAt,
      responseLimit: detail.responseLimit,
      closedMessage: detail.closedMessage,
    })
    setCloseDraft(closeFromDetail())
  }

  const updateClose = useUpdateCloseSettings()
  const updateNotify = useUpdateNotifyOnSubmission()

  // Диалог-страховка: уход с несохранёнными правками любой секции — осознанный.
  const [confirmOpen, setConfirmOpen] = useState(false)

  const trimmedUrl = draft.redirectUrl.trim()
  const urlInvalid = trimmedUrl !== '' && !isHttpUrl(trimmedUrl)
  const afterSubmitDirty = draft.thankYouText !== thankYouText || trimmedUrl !== redirectUrl

  const limitTrimmed = closeDraft.limit.trim()
  const limitNum = Number(limitTrimmed)
  const limitInvalid = limitTrimmed !== '' && (!Number.isInteger(limitNum) || limitNum < 1)
  const closeDirty =
    closeDraft.closeLocal !== isoToLocalInput(detail.closeAt) ||
    limitTrimmed !== (detail.responseLimit === null ? '' : String(detail.responseLimit)) ||
    closeDraft.message !== (detail.closedMessage ?? '')

  const dirty = afterSubmitDirty || closeDirty

  function saveAfterSubmit() {
    if (urlInvalid) return
    // В стор уходит уже подчищенный URL — именно он поедет в схему.
    setAfterSubmit({ thankYouText: draft.thankYouText, redirectUrl: trimmedUrl })
    onSaved()
  }

  function saveClose() {
    if (limitInvalid) return
    void ensureForm()
      .then(({ id }) =>
        updateClose.mutate({
          id,
          settings: {
            closeAt: localInputToIso(closeDraft.closeLocal),
            responseLimit: limitTrimmed === '' ? null : limitNum,
            closedMessage: closeDraft.message,
          },
        }),
      )
      .catch(() => toast.error(CREATE_FAILED))
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
          Что респондент увидит, когда отправит ответ. Нужен экран посложнее — соберите
          страницу «Спасибо» на полотне: включите тумблер на последнем разрыве страницы, и
          она заменит этот текст.
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

        <div className="mt-6 flex items-center gap-3">
          <Button onClick={saveAfterSubmit} disabled={!afterSubmitDirty || urlInvalid}>
            Сохранить
          </Button>
          <span className="text-xs text-muted-foreground" role="status">
            {urlInvalid
              ? 'Проверьте ссылку'
              : afterSubmitDirty
                ? 'Есть несохранённые изменения'
                : 'Всё сохранено'}
          </span>
        </div>
      </section>

      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-medium">Закрытие формы</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Когда прекратить приём ответов. Закрытая форма показывает текст ниже вместо вопросов.
        </p>

        <Label htmlFor="close-at" className="mt-4 block text-sm font-medium">
          Дата закрытия <span className="text-muted-foreground">(необязательно)</span>
        </Label>
        <Input
          id="close-at"
          type="datetime-local"
          value={closeDraft.closeLocal}
          onChange={(e) => setCloseDraft((d) => ({ ...d, closeLocal: e.target.value }))}
          className="mt-1.5"
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          После этого момента форма перестанет принимать ответы. Пусто — без ограничения по дате.
        </p>

        <Label htmlFor="response-limit" className="mt-4 block text-sm font-medium">
          Лимит ответов <span className="text-muted-foreground">(необязательно)</span>
        </Label>
        <Input
          id="response-limit"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={closeDraft.limit}
          placeholder="Например, 100"
          aria-invalid={limitInvalid}
          aria-describedby="response-limit-hint"
          onChange={(e) => setCloseDraft((d) => ({ ...d, limit: e.target.value }))}
          className="mt-1.5"
        />
        <p
          id="response-limit-hint"
          className={`mt-1.5 text-xs ${limitInvalid ? 'text-destructive' : 'text-muted-foreground'}`}
          role={limitInvalid ? 'alert' : undefined}
        >
          {limitInvalid
            ? 'Лимит — целое число больше нуля.'
            : 'Форма закроется, набрав столько ответов. Пусто — без лимита.'}
        </p>

        <Label htmlFor="closed-message" className="mt-4 block text-sm font-medium">
          Текст «приём закрыт» <span className="text-muted-foreground">(необязательно)</span>
        </Label>
        <Textarea
          id="closed-message"
          value={closeDraft.message}
          placeholder="Приём ответов на эту форму закрыт."
          maxLength={MAX_CLOSED_MESSAGE_LEN}
          onChange={(e) => setCloseDraft((d) => ({ ...d, message: e.target.value }))}
          className="mt-1.5"
        />

        <div className="mt-6 flex items-center gap-3">
          <Button onClick={saveClose} disabled={!closeDirty || limitInvalid || updateClose.isPending}>
            {updateClose.isPending ? 'Сохраняем…' : 'Сохранить'}
          </Button>
          <span
            className={`text-xs ${updateClose.isError ? 'text-destructive' : 'text-muted-foreground'}`}
            role="status"
          >
            {limitInvalid
              ? 'Проверьте лимит'
              : updateClose.isError
                ? 'Не удалось сохранить'
                : closeDirty
                  ? 'Есть несохранённые изменения'
                  : 'Всё сохранено'}
          </span>
        </div>
      </section>

      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-medium">Уведомления</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Письмо на вашу почту, когда на форму приходит новый ответ.
        </p>

        {/* Одиночный тумблер сохраняется сразу по переключению (не кнопкой, как секции
            выше): его состояние и есть сохранённое значение, «сохранилось ли» не
            двусмысленно. Поэтому в dirty-страховку ухода он не входит. Частые ответы
            склеиваются в одно письмо — троттлинг на бэкенде. */}
        <div className="mt-4 flex items-center gap-3">
          <Switch
            id="notify-on-submission"
            checked={detail.notifyOnSubmission}
            disabled={updateNotify.isPending}
            onCheckedChange={(enabled) =>
              void ensureForm()
                .then(({ id, slug }) => updateNotify.mutate({ id, slug, enabled }))
                .catch(() => toast.error(CREATE_FAILED))
            }
          />
          <Label htmlFor="notify-on-submission" className="text-sm font-normal">
            Присылать письмо о новом ответе
          </Label>
          {updateNotify.isError && (
            <span className="text-xs text-destructive" role="status">
              Не удалось сохранить
            </span>
          )}
        </div>
      </section>

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

// isoToLocalInput — ISO-строка (UTC с сервера) → значение <input type="datetime-local">
// (локальное время, поминутная точность). Пусто/битое → пустая строка.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// localInputToIso — значение datetime-local (локальное время) → ISO (UTC) для сервера.
// Пусто/битое → null (ограничение по дате снято).
function localInputToIso(local: string): string | null {
  if (local.trim() === '') return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}
