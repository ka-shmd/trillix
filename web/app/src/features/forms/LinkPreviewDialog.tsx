import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { mediaSrc } from '@fields/media'
import {
  EMPTY_LINK_PREVIEW,
  MAX_LINK_PREVIEW_DESCRIPTION_LEN,
  MAX_LINK_PREVIEW_SITE_NAME_LEN,
  MAX_LINK_PREVIEW_TITLE_LEN,
  displayFormTitle,
  type FormDetail,
  type LinkPreview,
} from '../../entities/form'
import { useFeatureAllowed } from '../plan/useFeature'
import { uploadImage, type UploadPurpose } from './builder/mediaUpload'
import { LinkPreviewCard } from './LinkPreviewCard'
import { useUpdateLinkPreview } from './queries'
import { ProTag } from '../../shared/ProTag'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

// Окно настройки карточки ссылки: пять полей слева, живой предпросмотр справа.
//
// НАСТРАИВАТЬ МОЖЕТ ЛЮБОЙ ТАРИФ, применяется карточка только на платном — то же
// решение, что у бейджа (internal/forms/service.go, LinkPreviewFor). Поля поэтому
// не блокируются: гейт закрывает результат, а не орган управления, и человек,
// которому предлагают заплатить, вправе сперва увидеть, за что. Отказывает бэк
// (инвариант 3) — точнее, публичная страница, которая просто возьмёт дефолты.
//
// Правки живут в локальном черновике до «Сохранить»: карточка сохраняется целиком
// одним PATCH'ем, и промежуточные состояния уезжать на сервер не должны.
export function LinkPreviewDialog({
  form,
  open,
  onOpenChange,
}: {
  form: FormDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const saved = form.linkPreview ?? EMPTY_LINK_PREVIEW
  const [draft, setDraft] = useState<LinkPreview>(saved)
  // Деталь формы — источник истины: её могли поменять в другой вкладке. Сверка в
  // рендере, а не эффектом (тот дал бы лишний каскадный рендер) — тот же приём,
  // что на странице настроек формы.
  const [synced, setSynced] = useState<LinkPreview>(saved)
  if (synced !== saved && !open) {
    setSynced(saved)
    setDraft(saved)
  }

  const allowed = useFeatureAllowed('form_link_preview')
  const update = useUpdateLinkPreview()
  const set = (patch: Partial<LinkPreview>) => setDraft((d) => ({ ...d, ...patch }))

  // Закрытие ВЫБРАСЫВАЕТ набранное — и «Отмена», и крестик, и Escape. Без этого
  // окно, закрытое без сохранения, при следующем открытии показывало бы брошенный
  // черновик вместо сохранённой карточки: снаружи это читается как «оно всё-таки
  // сохранилось». Картинка, успевшая загрузиться, остаётся в хранилище сиротой —
  // ровно как у обложки и логотипа (TD-16).
  function close() {
    setDraft(saved)
    onOpenChange(false)
  }

  function save() {
    update.mutate(
      { id: form.id, preview: draft },
      {
        // Закрываем БЕЗ сброса черновика: сохранённое значение приедет в деталь
        // формы, и сверка с ней сама подтянет карточку в оба состояния.
        onSuccess: () => onOpenChange(false),
        onError: () => toast.error('Не удалось сохранить карточку. Попробуйте ещё раз.'),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      {/* Шире стандартных sm:max-w-lg: окно двухколоночное, и предпросмотр в
          колонку с полями не встаёт. На узком экране колонки складываются в одну,
          предпросмотр уезжает вниз — под поля, которые его меняют. */}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Карточка ссылки
            <ProTag />
          </DialogTitle>
          <DialogDescription>
            Так ссылка на форму выглядит в мессенджерах, соцсетях и поисковой выдаче. Пустое поле
            оставляет то, что подставляется само.
          </DialogDescription>
        </DialogHeader>

        {!allowed && (
          // Плашка, а не блокировка полей: настроить и посмотреть можно, применится
          // после перехода на платный тариф. Ссылка на тариф — в метке ПРО заголовка.
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            Настроить карточку можно на любом тарифе, но к опубликованной форме она применится
            только на платном — сейчас по ссылке показывается карточка по умолчанию.
          </p>
        )}

        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-8">
          <div className="flex flex-col gap-4">
            <Field label="Имя сайта" id="lp-site-name">
              <Input
                id="lp-site-name"
                value={draft.siteName}
                placeholder="Название вашей компании"
                maxLength={MAX_LINK_PREVIEW_SITE_NAME_LEN}
                onChange={(e) => set({ siteName: e.target.value })}
              />
            </Field>

            <Field label="Иконка сайта" id="lp-icon" hint="Показывается рядом с адресом, 32×32">
              <ImageSlot
                formId={form.id}
                purpose="icon"
                imageKey={draft.iconKey}
                onChange={(iconKey) => set({ iconKey })}
                className="size-24"
                label="Иконка"
              />
            </Field>

            <Field label="Заголовок" id="lp-title">
              <Input
                id="lp-title"
                value={draft.title}
                placeholder={displayFormTitle(form.title)}
                maxLength={MAX_LINK_PREVIEW_TITLE_LEN}
                onChange={(e) => set({ title: e.target.value })}
              />
            </Field>

            <Field label="Описание" id="lp-description">
              <Textarea
                id="lp-description"
                value={draft.description}
                placeholder="О чём форма и сколько времени займёт"
                maxLength={MAX_LINK_PREVIEW_DESCRIPTION_LEN}
                onChange={(e) => set({ description: e.target.value })}
              />
            </Field>

            <Field label="Картинка" id="lp-image" hint="Рекомендуемый размер — 1200×630">
              <ImageSlot
                formId={form.id}
                purpose="preview"
                imageKey={draft.imageKey}
                onChange={(imageKey) => set({ imageKey })}
                className="aspect-[1200/630] w-full"
                label="Картинка"
              />
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">Предпросмотр</p>
            <LinkPreviewCard form={form} preview={draft} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            Отмена
          </Button>
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Field — подпись над контролом плюс необязательная сноска под ним. Своя, а не из
// shared/page: у раздела страницы подпись поля живёт в другом ритме, а здесь поля
// стоят плотным столбцом внутри окна.
function Field({
  label,
  id,
  hint,
  children,
}: {
  label: string
  id: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ImageSlot — загрузка одной картинки: пустая рамка приглашает выбрать файл,
// загруженная показывает её с кнопкой «убрать». Тот же XHR-загрузчик, что у
// картинки блока (builder/mediaUpload.ts) — отличается только назначением, от
// которого зависит потолок ширины на сервере.
//
// Прогресса в процентах здесь нет намеренно: картинка карточки уже ужата до 1200
// (иконка — до 256), загрузка занимает доли секунды, и полоса успевала бы только
// мигнуть. Состояние «грузим» показывает сама рамка.
function ImageSlot({
  formId,
  purpose,
  imageKey,
  onChange,
  className,
  label,
}: {
  formId: string
  purpose: UploadPurpose
  imageKey: string
  onChange: (key: string) => void
  className: string
  label: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // позволить выбрать тот же файл повторно
    if (!file) return
    setError(null)
    setBusy(true)
    uploadImage(formId, file, {}, purpose)
      .then(onChange)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Ошибка загрузки'))
      .finally(() => setBusy(false))
  }

  return (
    <div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={onFile}
      />
      {imageKey ? (
        <div className={`group relative overflow-hidden rounded-md border ${className}`}>
          <img src={mediaSrc(imageKey)} alt="" className="size-full object-contain" />
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
              Заменить
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onChange('')}>
              <Trash2 className="size-3.5" />
              Убрать
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className={`flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-muted-foreground/40 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:cursor-default ${className}`}
        >
          <ImagePlus className="size-4" />
          {busy ? 'Загружаем…' : label}
        </button>
      )}
      {error && <p className="mt-1.5 text-sm text-destructive">{error}</p>}
    </div>
  )
}
