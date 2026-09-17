import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'

import {
  MAX_CONSENT_DOC_TEXT_LEN,
  MAX_CONSENT_EMAIL_LEN,
  MAX_CONSENT_OPERATOR_ADDRESS_LEN,
  MAX_CONSENT_OPERATOR_INN_LEN,
  MAX_CONSENT_OPERATOR_NAME_LEN,
  MAX_CONSENT_PURPOSE_LEN,
  MAX_CONSENT_RETENTION_LEN,
  type ConsentOperatorItem,
} from '../../../entities/consent'
import { humanError } from '../../../shared/api/errors'
import { ErrorState, LoadingRows } from '../../../shared/page/states'
import { previewFormConsent } from '../api'
import { consentOperatorsQueryOptions, useDeleteConsentOperator } from '../queries'
import { consentSettingsValue, type ConsentDraft, type ConsentInvalid } from './consentDraft'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type DocKind = 'consent' | 'policy'
type SetConsent = <K extends keyof ConsentDraft>(key: K, value: ConsentDraft[K]) => void

// Поля раздела «Персональные данные» под включённым тумблером согласия
// (docs/design/privacy-consent.md §3.2, §3.6): один выбор источника на оба документа.
// Типовые — реквизиты оператора с подсказкой из списка пространства, цель и срок,
// предпросмотр; свои — два текста. Поля невыбранного источника не рисуются.
export function ConsentFields({
  formId,
  workspaceId,
  draft,
  set,
  invalid,
}: {
  formId: string
  workspaceId: string
  draft: ConsentDraft
  set: SetConsent
  invalid: ConsentInvalid
}) {
  return (
    <Tabs
      value={draft.documents}
      onValueChange={(v) => set('documents', v as ConsentDraft['documents'])}
      className="gap-4"
    >
      <div className="flex items-center gap-3">
        <span id="consent-documents-label" className="text-sm font-semibold">
          Документы
        </span>
        <TabsList aria-labelledby="consent-documents-label">
          <TabsTrigger value="template" className="px-3">
            Типовые
          </TabsTrigger>
          <TabsTrigger value="custom" className="px-3">
            Свои
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="template">
        <TemplateFields
          formId={formId}
          workspaceId={workspaceId}
          draft={draft}
          set={set}
          invalid={invalid}
        />
      </TabsContent>
      <TabsContent value="custom" className="flex flex-col gap-4">
        <DocText
          id="consent-text"
          label="Согласие на обработку персональных данных"
          placeholder="Вставьте текст согласия"
          value={draft.consentText}
          onChange={(v) => set('consentText', v)}
        />
        <DocText
          id="policy-text"
          label="Политика обработки персональных данных"
          placeholder="Вставьте текст политики"
          value={draft.policyText}
          onChange={(v) => set('policyText', v)}
        />
      </TabsContent>
    </Tabs>
  )
}

// Подпись слева колонкой, поле справа; на узком экране подпись встаёт над полем.
const FIELD_ROW = 'grid gap-1.5 sm:grid-cols-[10rem_1fr] sm:items-center sm:gap-4'

function TemplateFields({
  formId,
  workspaceId,
  draft,
  set,
  invalid,
}: {
  formId: string
  workspaceId: string
  draft: ConsentDraft
  set: SetConsent
  invalid: ConsentInvalid
}) {
  // Предпросмотр ничего на сервере не меняет — мутация здесь ради состояния запроса,
  // кэшировать и инвалидировать нечего.
  const preview = useMutation({
    mutationFn: () => previewFormConsent(formId, consentSettingsValue(draft)),
  })
  const [shown, setShown] = useState<DocKind | null>(null)
  function openPreview(kind: DocKind) {
    setShown(kind)
    preview.mutate()
  }
  const shownDoc = shown && preview.data ? preview.data[shown] : null

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Согласие и политику соберём из ваших реквизитов: оператор персональных данных — вы.
      </p>

      <div className={FIELD_ROW}>
        <Label htmlFor="consent-operator-name">Оператор</Label>
        <OperatorNameField workspaceId={workspaceId} draft={draft} set={set} />
      </div>
      <div className={FIELD_ROW}>
        <Label htmlFor="consent-operator-inn">ИНН</Label>
        <div>
          <Input
            id="consent-operator-inn"
            inputMode="numeric"
            placeholder="Необязательно"
            aria-invalid={invalid.inn}
            value={draft.inn}
            maxLength={MAX_CONSENT_OPERATOR_INN_LEN}
            onChange={(e) => set('inn', e.target.value)}
          />
          {invalid.inn && (
            <p className="mt-1.5 text-sm text-destructive" role="alert">
              ИНН — 10 или 12 цифр
            </p>
          )}
        </div>
      </div>
      <div className={FIELD_ROW}>
        <Label htmlFor="consent-operator-address">Адрес</Label>
        <Input
          id="consent-operator-address"
          placeholder="Юридический адрес или адрес регистрации"
          value={draft.address}
          maxLength={MAX_CONSENT_OPERATOR_ADDRESS_LEN}
          onChange={(e) => set('address', e.target.value)}
        />
      </div>
      <div className={FIELD_ROW}>
        <Label htmlFor="consent-operator-email">Email для отзыва</Label>
        <div>
          <Input
            id="consent-operator-email"
            type="email"
            inputMode="email"
            placeholder="Сюда напишут, чтобы отозвать согласие"
            aria-invalid={invalid.email}
            value={draft.email}
            maxLength={MAX_CONSENT_EMAIL_LEN}
            onChange={(e) => set('email', e.target.value)}
          />
          {invalid.email && (
            <p className="mt-1.5 text-sm text-destructive" role="alert">
              Нужен адрес вида name@example.com
            </p>
          )}
        </div>
      </div>

      <div className={FIELD_ROW}>
        <Label htmlFor="consent-purpose">Цель обработки</Label>
        <Input
          id="consent-purpose"
          placeholder="Как в типовом тексте"
          value={draft.purpose}
          maxLength={MAX_CONSENT_PURPOSE_LEN}
          onChange={(e) => set('purpose', e.target.value)}
        />
      </div>
      <div className={FIELD_ROW}>
        <Label htmlFor="consent-retention">Срок обработки</Label>
        <Input
          id="consent-retention"
          placeholder="Как в типовом тексте"
          value={draft.retention}
          maxLength={MAX_CONSENT_RETENTION_LEN}
          onChange={(e) => set('retention', e.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          onClick={() => openPreview('consent')}
        >
          Посмотреть согласие
        </Button>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          onClick={() => openPreview('policy')}
        >
          Посмотреть политику
        </Button>
      </div>

      <Dialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {shown === 'policy'
                ? 'Политика обработки персональных данных'
                : 'Согласие на обработку персональных данных'}
            </DialogTitle>
            <DialogDescription>Так документ увидит респондент.</DialogDescription>
          </DialogHeader>
          {preview.isPending ? (
            <LoadingRows rows={6} />
          ) : preview.isError ? (
            <ErrorState
              title="Не удалось собрать документ."
              description={humanError(preview.error)}
              onRetry={() => preview.mutate()}
            />
          ) : (
            shownDoc && <p className="text-sm whitespace-pre-wrap">{shownDoc.text}</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function sameOperator(it: ConsentOperatorItem, d: ConsentDraft): boolean {
  return (
    it.name === d.name.trim() &&
    it.inn === d.inn.trim() &&
    it.address === d.address.trim() &&
    it.email === d.email.trim()
  )
}

// operatorDetails — вторая строка варианта подсказки: по ней различают два набора с
// одним наименованием (другой адрес, другая почта).
function operatorDetails(it: ConsentOperatorItem): string {
  return [it.inn && `ИНН ${it.inn}`, it.address, it.email].filter(Boolean).join(' · ')
}

// Поле «Оператор» с подсказкой из списка реквизитов пространства (спека §3.6).
//
// Подсказка открывается под полем, пока в нём фокус, и фокус остаётся в поле: автор
// печатает, а список сужается по наименованию. Стрелка вниз уводит в варианты. Набор,
// совпадающий с уже введённым, не предлагается — выбирать его незачем.
function OperatorNameField({
  workspaceId,
  draft,
  set,
}: {
  workspaceId: string
  draft: ConsentDraft
  set: SetConsent
}) {
  const operators = useQuery(consentOperatorsQueryOptions(workspaceId))
  const remove = useDeleteConsentOperator(workspaceId)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  // Закрыта автором (Escape, выбор) — до следующего набора или фокуса.
  const [dismissed, setDismissed] = useState(false)

  const typed = draft.name.trim().toLocaleLowerCase('ru')
  const suggestions = (operators.data ?? []).filter(
    (it) => !sameOperator(it, draft) && it.name.toLocaleLowerCase('ru').includes(typed),
  )
  const open = focused && !dismissed && suggestions.length > 0

  function options(): HTMLButtonElement[] {
    return Array.from(listRef.current?.querySelectorAll('[data-operator-option]') ?? [])
  }

  function pick(it: ConsentOperatorItem) {
    set('name', it.name)
    set('inn', it.inn)
    set('address', it.address)
    set('email', it.email)
    setDismissed(true)
    inputRef.current?.focus()
  }

  // Фокус ушёл и не в подсказку — подсказка закрывается.
  function leave(next: EventTarget | null) {
    const node = next instanceof Node ? next : null
    if (node && (listRef.current?.contains(node) || inputRef.current === node)) return
    setFocused(false)
  }

  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <Input
          ref={inputRef}
          id="consent-operator-name"
          placeholder="ООО «Ромашка» или ИП Иванов Иван Иванович"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={open ? 'consent-operator-suggestions' : undefined}
          value={draft.name}
          maxLength={MAX_CONSENT_OPERATOR_NAME_LEN}
          onChange={(e) => {
            set('name', e.target.value)
            setDismissed(false)
          }}
          onFocus={() => {
            setFocused(true)
            setDismissed(false)
          }}
          onBlur={(e) => leave(e.relatedTarget)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && open) {
              e.preventDefault()
              options()[0]?.focus()
            } else if (e.key === 'Escape' && open) {
              e.preventDefault()
              setDismissed(true)
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) p-1"
        // Фокус остаётся в поле: подсказка сопровождает набор, а не перехватывает его.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={() => {
          setDismissed(true)
          inputRef.current?.focus()
        }}
        onInteractOutside={(e) => {
          if (e.target === inputRef.current) e.preventDefault()
          else setFocused(false)
        }}
      >
        <div
          ref={listRef}
          id="consent-operator-suggestions"
          role="group"
          aria-label="Реквизиты из других форм"
          onBlur={(e) => leave(e.relatedTarget)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
            e.preventDefault()
            const all = options()
            const at = all.indexOf(document.activeElement as HTMLButtonElement)
            const next = at + (e.key === 'ArrowDown' ? 1 : -1)
            if (next < 0) inputRef.current?.focus()
            else all[Math.min(next, all.length - 1)]?.focus()
          }}
        >
          <p className="px-2 py-1.5 text-sm text-muted-foreground">Из других форм</p>
          {suggestions.map((it) => (
            <div key={it.id} className="flex items-center rounded-md hover:bg-accent">
              <button
                type="button"
                data-operator-option
                className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left outline-none focus-visible:bg-accent"
                onClick={() => pick(it)}
              >
                <span className="block truncate text-sm font-medium">{it.name}</span>
                <span className="block truncate text-sm text-muted-foreground">
                  {operatorDetails(it)}
                </span>
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Убрать из списка"
                    onClick={() => remove.mutate(it.id)}
                  >
                    <X className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Убрать из списка</TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function DocText({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        placeholder={placeholder}
        value={value}
        maxLength={MAX_CONSENT_DOC_TEXT_LEN}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-40"
      />
    </div>
  )
}
