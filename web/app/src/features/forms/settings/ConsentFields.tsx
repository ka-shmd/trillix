import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'

import {
  MAX_CONSENT_DOC_TEXT_LEN,
  MAX_CONSENT_EMAIL_LEN,
  MAX_CONSENT_OPERATOR_ADDRESS_LEN,
  MAX_CONSENT_OPERATOR_NAME_LEN,
  MAX_CONSENT_PURPOSE_LEN,
  MAX_CONSENT_RETENTION_LEN,
  type ConsentPreview,
} from '../../../entities/consent'
import { humanError } from '../../../shared/api/errors'
import { ErrorState, LoadingRows } from '../../../shared/page/states'
import { previewFormConsent } from '../api'
import { consentSettingsValue, type ConsentDraft, type ConsentInvalid } from './consentDraft'
import { Row } from './Row'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

type DocKind = 'consent' | 'policy'

// Поля раздела «Персональные данные» под включённым тумблером согласия
// (docs/design/privacy-consent.md): реквизиты оператора для типового текста и два
// документа — у каждого выбор «Типовой» или «Свой текст».
//
// Реквизиты показываются, только пока хоть один документ типовой: свой текст несёт
// их сам, и пустые поля под ним спрашивали бы то, что нигде не появится.
export function ConsentFields({
  formId,
  draft,
  set,
  invalid,
}: {
  formId: string
  draft: ConsentDraft
  set: <K extends keyof ConsentDraft>(key: K, value: ConsentDraft[K]) => void
  invalid: ConsentInvalid
}) {
  const cell = 'h-8 w-full border-0 bg-transparent px-0 shadow-none focus-visible:ring-0'
  const needsOperator = draft.consentMode === 'template' || draft.policyMode === 'template'

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

  // Свой текст начинается с типового: править готовый документ проще, чем писать с
  // нуля. Подставляется только в ПУСТОЕ поле — вставленное автором не затирается.
  function switchMode(kind: DocKind, mode: 'template' | 'custom') {
    set(kind === 'consent' ? 'consentMode' : 'policyMode', mode)
    const text = kind === 'consent' ? draft.consentText : draft.policyText
    if (mode !== 'custom' || text.trim() !== '') return
    void previewFormConsent(formId, consentSettingsValue(draft))
      .then((docs: ConsentPreview) =>
        set(kind === 'consent' ? 'consentText' : 'policyText', docs[kind].text),
      )
      .catch(() => {})
  }

  const shownDoc = shown && preview.data ? preview.data[shown] : null

  return (
    <div className="flex flex-col gap-4">
      {needsOperator && (
        <div>
          <div className="rounded-lg border bg-card shadow-sm">
            <Row label="Оператор">
              <Input
                aria-label="Наименование организации или ФИО"
                placeholder="ООО «Ромашка» или ИП Иванов Иван Иванович"
                value={draft.name}
                maxLength={MAX_CONSENT_OPERATOR_NAME_LEN}
                onChange={(e) => set('name', e.target.value)}
                className={cell}
              />
            </Row>
            <Row label="ИНН">
              <div className="w-full">
                <Input
                  aria-label="ИНН оператора"
                  inputMode="numeric"
                  placeholder="Необязательно"
                  aria-invalid={invalid.inn}
                  value={draft.inn}
                  maxLength={12}
                  onChange={(e) => set('inn', e.target.value)}
                  className={cell}
                />
                {invalid.inn && (
                  <p className="pb-1 text-sm text-destructive" role="alert">
                    ИНН — 10 или 12 цифр
                  </p>
                )}
              </div>
            </Row>
            <Row label="Адрес">
              <Input
                aria-label="Адрес оператора"
                value={draft.address}
                maxLength={MAX_CONSENT_OPERATOR_ADDRESS_LEN}
                onChange={(e) => set('address', e.target.value)}
                className={cell}
              />
            </Row>
            <Row label="Email для отзыва согласия">
              <div className="w-full">
                <Input
                  type="email"
                  inputMode="email"
                  aria-label="Email для отзыва согласия"
                  aria-invalid={invalid.email}
                  value={draft.email}
                  maxLength={MAX_CONSENT_EMAIL_LEN}
                  onChange={(e) => set('email', e.target.value)}
                  className={cell}
                />
                {invalid.email && (
                  <p className="pb-1 text-sm text-destructive" role="alert">
                    Нужен адрес вида name@example.com
                  </p>
                )}
              </div>
            </Row>
            <Row label="Цель обработки">
              <Input
                aria-label="Цель обработки"
                placeholder="Как в типовом тексте"
                value={draft.purpose}
                maxLength={MAX_CONSENT_PURPOSE_LEN}
                onChange={(e) => set('purpose', e.target.value)}
                className={cell}
              />
            </Row>
            <Row label="Срок обработки">
              <Input
                aria-label="Срок обработки"
                placeholder="Как в типовом тексте"
                value={draft.retention}
                maxLength={MAX_CONSENT_RETENTION_LEN}
                onChange={(e) => set('retention', e.target.value)}
                className={cell}
              />
            </Row>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Оператор персональных данных — вы: эти сведения попадут в типовой текст согласия и
            политики.
          </p>
        </div>
      )}

      <ConsentDocField
        label="Согласие"
        mode={draft.consentMode}
        text={draft.consentText}
        missing={invalid.consentTextMissing}
        onMode={(m) => switchMode('consent', m)}
        onText={(v) => set('consentText', v)}
        onPreview={() => openPreview('consent')}
      />
      <ConsentDocField
        label="Политика обработки данных"
        mode={draft.policyMode}
        text={draft.policyText}
        missing={invalid.policyTextMissing}
        onMode={(m) => switchMode('policy', m)}
        onText={(v) => set('policyText', v)}
        onPreview={() => openPreview('policy')}
      />

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

function ConsentDocField({
  label,
  mode,
  text,
  missing,
  onMode,
  onText,
  onPreview,
}: {
  label: string
  mode: 'template' | 'custom'
  text: string
  missing: boolean
  onMode: (mode: 'template' | 'custom') => void
  onText: (text: string) => void
  onPreview: () => void
}) {
  return (
    <div className="rounded-lg border bg-card shadow-sm">
      <div className="flex min-h-10 items-center justify-between gap-2 px-3">
        <span className="text-sm font-semibold">{label}</span>
        <div className="flex items-center gap-2">
          {mode === 'template' && (
            <Button type="button" variant="ghost" size="sm" onClick={onPreview}>
              Посмотреть
            </Button>
          )}
          <Select value={mode} onValueChange={(v) => onMode(v as 'template' | 'custom')}>
            <SelectTrigger size="sm" aria-label={`Текст документа «${label}»`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="template">Типовой</SelectItem>
              <SelectItem value="custom">Свой текст</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {mode === 'custom' && (
        <div className="border-t px-3 py-2">
          <Textarea
            aria-label={`Свой текст документа «${label}»`}
            placeholder="Вставьте текст документа"
            value={text}
            maxLength={MAX_CONSENT_DOC_TEXT_LEN}
            onChange={(e) => onText(e.target.value)}
            className="min-h-48 border-0 px-0 shadow-none focus-visible:ring-0"
          />
          {missing && (
            <p className="pt-1 text-sm text-muted-foreground">
              Вставьте текст — без него согласие не сохранить.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
