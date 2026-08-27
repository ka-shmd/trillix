import { useState } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { toast } from 'sonner'

import { isHttpUrl, MAX_REDIRECT_URL_LEN, MAX_THANK_YOU_TEXT_LEN } from '@entities/formSchema'
import { MAX_CLOSED_MESSAGE_LEN, type FormDetail } from '../../../entities/form'
import { ApiError } from '../../../shared/api/errors'
import { Section } from '../../../shared/page/Section'
import {
  useUpdateAfterSubmit,
  useUpdateCloseSettings,
  useUpdateCollectPartial,
  useUpdateNotifyOnSubmission,
} from '../queries'

import { InstantSwitch } from './InstantSwitch'
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

// Настройки формы — то, чего на полотне не видно: экран после отправки, закрытие
// приёма, письма о новых ответах, сбор незавершённых.
//
// РАЗДЕЛ ФОРМЫ, а не режим редактора (решение владельца 2026-08-26, отменяет прежнее
// «ссылки на настройки нет»): у настроек появился свой адрес, они стоят в одном ряду
// с «Поделиться · Аналитика · Ответы · Интеграции», и на них можно послать ссылкой —
// чем и пользуется вкладка «Частичные», отправляя сюда за тумблером сбора.
//
// Два источника истины, и их нельзя слипать. «После отправки» — поля СХЕМЫ: правятся
// PATCH'ем черновика (`useUpdateAfterSubmit`) с оптимистичной блокировкой по
// updatedAt, тем же приёмом, каким экран «Встроить» правит бейдж. Остальное — живые
// колонки `forms` со своими мутациями, схемы не касаются вовсе.
//
// Сохранение секций со схемой и закрытием — ЯВНОЕ, кнопкой (решение владельца):
// молчаливый автосейв здесь ломает флоу, человек не понимает, сохранилось ли.
// Тумблеры — наоборот, мгновенные: положение тумблера и есть сохранённое значение.
// Уход с несохранёнными правками стережёт диалог поверх навигации роутера.
export function FormSettingsView({ form }: { form: FormDetail }) {
  const schema = form.draftSchema
  const savedAfterSubmit = {
    thankYouText: schema.thankYouText ?? '',
    redirectUrl: schema.redirectUrl ?? '',
  }

  const [draft, setDraft] = useState(savedAfterSubmit)
  // Деталь формы — источник истины: её меняют мимо этой страницы (редактор, другая
  // вкладка), и черновик обязан догнать. Сверка в рендере, а не эффектом: эффект
  // здесь дал бы лишний каскадный рендер (react-hooks/set-state-in-effect).
  const [synced, setSynced] = useState(savedAfterSubmit)
  if (
    synced.thankYouText !== savedAfterSubmit.thankYouText ||
    synced.redirectUrl !== savedAfterSubmit.redirectUrl
  ) {
    setSynced(savedAfterSubmit)
    setDraft(savedAfterSubmit)
  }

  const closeFromDetail = () => ({
    closeLocal: isoToLocalInput(form.closeAt),
    limit: form.responseLimit === null ? '' : String(form.responseLimit),
    message: form.closedMessage ?? '',
  })
  const [closeDraft, setCloseDraft] = useState(closeFromDetail)
  const [closeSynced, setCloseSynced] = useState({
    closeAt: form.closeAt,
    responseLimit: form.responseLimit,
    closedMessage: form.closedMessage,
  })
  if (
    closeSynced.closeAt !== form.closeAt ||
    closeSynced.responseLimit !== form.responseLimit ||
    closeSynced.closedMessage !== form.closedMessage
  ) {
    setCloseSynced({
      closeAt: form.closeAt,
      responseLimit: form.responseLimit,
      closedMessage: form.closedMessage,
    })
    setCloseDraft(closeFromDetail())
  }

  const updateAfterSubmit = useUpdateAfterSubmit()
  const updateClose = useUpdateCloseSettings()
  const updateNotify = useUpdateNotifyOnSubmission()
  const updatePartial = useUpdateCollectPartial()

  const trimmedUrl = draft.redirectUrl.trim()
  const urlInvalid = trimmedUrl !== '' && !isHttpUrl(trimmedUrl)
  const afterSubmitDirty =
    draft.thankYouText !== savedAfterSubmit.thankYouText ||
    trimmedUrl !== savedAfterSubmit.redirectUrl

  const limitTrimmed = closeDraft.limit.trim()
  const limitNum = Number(limitTrimmed)
  const limitInvalid = limitTrimmed !== '' && (!Number.isInteger(limitNum) || limitNum < 1)
  const closeDirty =
    closeDraft.closeLocal !== isoToLocalInput(form.closeAt) ||
    limitTrimmed !== (form.responseLimit === null ? '' : String(form.responseLimit)) ||
    closeDraft.message !== (form.closedMessage ?? '')

  const dirty = afterSubmitDirty || closeDirty

  // Уход с несохранёнными правками — осознанный. Блокируется НАВИГАЦИЯ роутера
  // (табы, крошки, «Назад» браузера) плюс закрытие вкладки: страница живёт внутри
  // оболочки формы, и уйти с неё можно десятком ссылок, а не одной кнопкой «назад»,
  // как было в редакторе.
  const blocker = useBlocker({ shouldBlockFn: () => dirty, withResolver: true })

  function saveAfterSubmit() {
    if (urlInvalid) return
    updateAfterSubmit.mutate(
      { form, thankYouText: draft.thankYouText, redirectUrl: trimmedUrl },
      { onError: () => toast.error('Не удалось сохранить. Попробуйте ещё раз.') },
    )
  }

  function saveClose() {
    if (limitInvalid) return
    updateClose.mutate({
      id: form.id,
      settings: {
        closeAt: localInputToIso(closeDraft.closeLocal),
        responseLimit: limitTrimmed === '' ? null : limitNum,
        closedMessage: closeDraft.message,
      },
    })
  }

  return (
    <div className="flex flex-col gap-12">
      <Section
        title="После отправки"
        description="Что респондент увидит, когда отправит ответ. Нужен экран посложнее — соберите страницу «Спасибо» на полотне: включите тумблер на последнем разрыве страницы, и она заменит этот текст."
      >
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="thank-you-text">Текст благодарности</Label>
            <Textarea
              id="thank-you-text"
              value={draft.thankYouText}
              placeholder="Спасибо! Ваш ответ отправлен."
              maxLength={MAX_THANK_YOU_TEXT_LEN}
              onChange={(e) => setDraft((d) => ({ ...d, thankYouText: e.target.value }))}
              className="mt-1.5"
            />
          </div>

          <div>
            <Label htmlFor="redirect-url">
              Ссылка перехода{' '}
              <span className="font-normal text-muted-foreground">(необязательно)</span>
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
              className={`mt-1.5 text-sm ${urlInvalid ? 'text-destructive' : 'text-muted-foreground'}`}
              role={urlInvalid ? 'alert' : undefined}
            >
              {urlInvalid
                ? 'Ссылка должна начинаться с http:// или https://'
                : trimmedUrl === ''
                  ? 'Оставьте пустым, чтобы респондент остался на экране благодарности.'
                  : 'Покажем текст благодарности и через пару секунд переведём по ссылке.'}
            </p>
          </div>

          <SaveRow
            onSave={saveAfterSubmit}
            disabled={!afterSubmitDirty || urlInvalid}
            pending={updateAfterSubmit.isPending}
            failed={updateAfterSubmit.isError}
            invalidHint={urlInvalid ? 'Проверьте ссылку' : undefined}
            dirty={afterSubmitDirty}
          />
        </div>
      </Section>

      <Section
        title="Закрытие формы"
        description="Когда прекратить приём ответов. Закрытая форма показывает текст ниже вместо вопросов."
      >
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="close-at">
              Дата закрытия{' '}
              <span className="font-normal text-muted-foreground">(необязательно)</span>
            </Label>
            <Input
              id="close-at"
              type="datetime-local"
              value={closeDraft.closeLocal}
              onChange={(e) => setCloseDraft((d) => ({ ...d, closeLocal: e.target.value }))}
              className="mt-1.5"
            />
            <p className="mt-1.5 text-sm text-muted-foreground">
              После этого момента форма перестанет принимать ответы. Пусто — без ограничения по
              дате.
            </p>
          </div>

          <div>
            <Label htmlFor="response-limit">
              Лимит ответов{' '}
              <span className="font-normal text-muted-foreground">(необязательно)</span>
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
              className={`mt-1.5 text-sm ${limitInvalid ? 'text-destructive' : 'text-muted-foreground'}`}
              role={limitInvalid ? 'alert' : undefined}
            >
              {limitInvalid
                ? 'Лимит — целое число больше нуля.'
                : 'Форма закроется, набрав столько ответов. Пусто — без лимита.'}
            </p>
          </div>

          <div>
            <Label htmlFor="closed-message">
              Текст «приём закрыт»{' '}
              <span className="font-normal text-muted-foreground">(необязательно)</span>
            </Label>
            <Textarea
              id="closed-message"
              value={closeDraft.message}
              placeholder="Приём ответов на эту форму закрыт."
              maxLength={MAX_CLOSED_MESSAGE_LEN}
              onChange={(e) => setCloseDraft((d) => ({ ...d, message: e.target.value }))}
              className="mt-1.5"
            />
          </div>

          <SaveRow
            onSave={saveClose}
            disabled={!closeDirty || limitInvalid}
            pending={updateClose.isPending}
            failed={updateClose.isError}
            invalidHint={limitInvalid ? 'Проверьте лимит' : undefined}
            dirty={closeDirty}
          />
        </div>
      </Section>

      <Section
        title="Уведомления"
        description="Письмо на вашу почту, когда на форму приходит новый ответ."
      >
        {/* Одиночный тумблер сохраняется сразу по переключению (не кнопкой, как секции
            выше): его состояние и есть сохранённое значение, «сохранилось ли» не
            двусмысленно. Поэтому в dirty-страховку ухода он не входит. Частые ответы
            склеиваются в одно письмо — троттлинг на бэкенде. */}
        <InstantSwitch
          id="notify-on-submission"
          label="Присылать письмо о новом ответе"
          checked={form.notifyOnSubmission}
          onToggle={(enabled) =>
            updateNotify
              .mutateAsync({ id: form.id, slug: form.slug, enabled })
              .then(() => undefined)
              .catch((e: unknown) => {
                toast.error('Не удалось сохранить. Попробуйте ещё раз.')
                throw e
              })
          }
        />
      </Section>

      {/* Якорь секции: вкладка «Частичные» ведёт сюда ссылкой с хешем, и человек,
          пришедший за тумблером сбора, обязан увидеть под курсором именно его, а не
          верх страницы настроек. */}
      <Section
        id="partial"
        title="Незавершённые ответы"
        description="Форма запомнит набранное, даже если человек её не отправит. Респондент увидит об этом предупреждение, а собранное появится на вкладке «Частичные»."
      >
        {/* Единственный тумблер продукта, который включает СБОР данных, а не их
            показ, — поэтому он и предупреждение живут от одного флага, и включить
            сбор молча нельзя. Отказ тарифа (402) приходит из мутации: показываем
            тост со ссылкой на тариф, а тумблер возвращается в выключенное положение
            сам (InstantSwitch сбрасывает своё состояние на ошибке). */}
        <InstantSwitch
          id="collect-partial"
          label="Собирать незавершённые ответы"
          checked={form.collectPartial}
          onToggle={(enabled) =>
            updatePartial
              .mutateAsync({ id: form.id, slug: form.slug, enabled })
              .then(() => undefined)
              .catch((e: unknown) => {
                toast.error(
                  e instanceof ApiError && e.code === 'plan_required'
                    ? 'Сбор незавершённых ответов доступен на платном тарифе'
                    : 'Не удалось сохранить. Попробуйте ещё раз.',
                )
                throw e
              })
          }
        />
      </Section>

      <AlertDialog open={blocker.status === 'blocked'}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Есть несохранённые изменения</AlertDialogTitle>
            <AlertDialogDescription>
              Настройки формы изменены, но не сохранены. Если уйти сейчас, правки пропадут.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>Остаться</AlertDialogCancel>
            <AlertDialogAction onClick={() => blocker.proceed?.()}>
              Уйти без сохранения
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// Ряд «Сохранить + состояние секции». Один на обе секции с явным сохранением: две
// одинаковые пары кнопки и подписи разъезжаются словами на первой же правке.
function SaveRow({
  onSave,
  disabled,
  pending,
  failed,
  invalidHint,
  dirty,
}: {
  onSave: () => void
  disabled: boolean
  pending: boolean
  failed: boolean
  invalidHint?: string
  dirty: boolean
}) {
  return (
    <div className="mt-2 flex items-center gap-3">
      <Button onClick={onSave} disabled={disabled || pending}>
        {pending ? 'Сохраняем…' : 'Сохранить'}
      </Button>
      <span
        className={`text-sm ${failed ? 'text-destructive' : 'text-muted-foreground'}`}
        role="status"
      >
        {invalidHint ??
          (failed
            ? 'Не удалось сохранить'
            : dirty
              ? 'Есть несохранённые изменения'
              : 'Всё сохранено')}
      </span>
    </div>
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

// localInputToIso — обратно: локальное значение поля → ISO в UTC. Пусто → null
// (настройка снята).
function localInputToIso(local: string): string | null {
  if (local.trim() === '') return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}
