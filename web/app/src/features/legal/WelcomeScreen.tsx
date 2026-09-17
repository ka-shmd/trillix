import { useEffect, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { consentsQueryOptions, useCompleteConsent } from './queries'
import {
  emptySignupDraft,
  legalDocumentPath,
  SIGNUP_INDUSTRIES,
  SIGNUP_OCCUPATIONS,
  SIGNUP_POSITIONS,
  SIGNUP_PURPOSES,
  SIGNUP_REFERRALS,
  signupProfileOf,
  type ConsentChange,
  type Consents,
  type SignupDraft,
  type SignupKind,
} from '../../entities/legal'
import { humanError } from '../../shared/api/errors'
import { formatDate } from '../../shared/format'
import { ErrorState } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

// Экран согласия (docs/design/signup-consent.md §3.3). Два варианта по ответу сервера:
// «Поделитесь парой деталей» — анкета по вкладкам «Частное лицо» и «Компания или ИП»
// (по образцу WebAsk, решение владельца 2026-09-17) и согласия; «Условия использования
// обновились» — только соглашение. Единственное действие — завершить, и оно доступно, как
// только отмечено соглашение: анкета необязательна, уйти с экрана без согласия нельзя.
//
// Экран — страница, а не окно: сверху название сервиса и шаг, заголовок вне карточки, в
// карточке разделы «О вас» и «Условия использования», под ними подвал с кнопкой и
// подсказкой, чего не хватает. История вида — JOURNAL, «Принятие условий при
// регистрации, слайс G».

interface Props {
  // defaultFullName — ФИО, известное из профиля (имя и фамилия от Яндекса), подставленное в
  // анкету заранее.
  defaultFullName: string
  // onDone — согласие принято: маршрут возвращает человека туда, куда он шёл.
  onDone: () => void
}

export function WelcomeScreen({ defaultFullName, onDone }: Props) {
  const consents = useQuery(consentsQueryOptions)
  const screen = consents.data?.screen

  // Согласие уже дано (в соседней вкладке или экран открыт по устаревшему кэшу me) —
  // держать человека здесь незачем.
  useEffect(() => {
    if (consents.data && screen === null) onDone()
  }, [consents.data, screen, onDone])

  if (consents.isPending) {
    return (
      <Shell step="Регистрация" title={<Skeleton className="h-9 w-80" />}>
        <Card className="gap-4 p-6 sm:p-8">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </Card>
      </Shell>
    )
  }
  // Без действующей редакции соглашения гейт не закрывается вовсе — сюда это доезжает
  // только сбоем, и показывается как сбой.
  if (consents.isError || !consents.data.terms) {
    return (
      <Shell step="Регистрация" title="Не удалось загрузить условия">
        <ErrorState
          title={humanError(consents.error)}
          retryLabel="Попробовать ещё раз"
          onRetry={() => void consents.refetch()}
        />
      </Shell>
    )
  }
  const { data } = consents
  const { terms } = data
  if (data.screen === null || !terms) return null

  return data.screen === 'signup' ? (
    <SignupForm consents={data} terms={terms} defaultFullName={defaultFullName} onDone={onDone} />
  ) : (
    <UpdateForm terms={terms} onDone={onDone} />
  )
}

type Terms = NonNullable<Consents['terms']>

function SignupForm({
  consents,
  terms,
  defaultFullName,
  onDone,
}: {
  consents: Consents
  terms: Terms
  defaultFullName: string
  onDone: () => void
}) {
  const [draft, setDraft] = useState<SignupDraft>(() => emptySignupDraft(defaultFullName))
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [acceptMarketing, setAcceptMarketing] = useState(false)
  const complete = useCompleteConsent()
  const set = <K extends keyof SignupDraft>(key: K, value: SignupDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const { marketing } = consents

  const submit = () => {
    const change: ConsentChange = { accept: [{ kind: 'terms', version: terms.version }] }
    if (marketing && acceptMarketing) change.accept?.push({ kind: 'marketing', version: marketing.version })
    complete.mutate({ change, profile: signupProfileOf(draft) }, { onSuccess: () => onDone() })
  }

  return (
    <Shell
      step="Регистрация · последний шаг"
      title="Поделитесь парой деталей"
      description="Помогите нам сделать Trillix лучше — расскажите о себе."
    >
      <Card className="gap-0 overflow-hidden py-0">
        <FormSection title="О вас">
          <div className="flex flex-col gap-5 sm:gap-4">
            <KindRow value={draft.kind} onChange={(kind) => set('kind', kind)} />

            <TextRow
              label="Ваше полное имя"
              placeholder="Например, Иванов Иван Иванович"
              value={draft.fullName}
              onChange={(v) => set('fullName', v)}
              maxLength={200}
            />

            {draft.kind === 'person' ? (
              <>
                <SelectRow
                  label="Чем вы занимаетесь?"
                  options={SIGNUP_OCCUPATIONS}
                  value={draft.occupation}
                  onChange={(v) => set('occupation', v)}
                />
                <TextRow
                  label="Ваша профессия"
                  placeholder="Например, дизайнер"
                  value={draft.profession}
                  onChange={(v) => set('profession', v)}
                  maxLength={100}
                />
              </>
            ) : (
              <>
                <TextRow
                  label="Название организации или ИП"
                  placeholder="Например, ООО «Ромашка»"
                  value={draft.companyName}
                  onChange={(v) => set('companyName', v)}
                  maxLength={300}
                />
                <SelectRow
                  label="Сфера деятельности"
                  options={SIGNUP_INDUSTRIES}
                  value={draft.industry}
                  onChange={(v) => set('industry', v)}
                />
                <SelectRow
                  label="Ваша должность"
                  options={SIGNUP_POSITIONS}
                  value={draft.jobPosition}
                  onChange={(v) => set('jobPosition', v)}
                />
              </>
            )}

            <SelectRow
              label="Как вы о нас узнали?"
              options={SIGNUP_REFERRALS}
              value={draft.referral}
              onChange={(v) => set('referral', v)}
            />
            <SelectRow
              label="Для чего вы будете использовать Trillix?"
              options={SIGNUP_PURPOSES}
              value={draft.purpose}
              onChange={(v) => set('purpose', v)}
            />
          </div>
        </FormSection>

        <FormSection title="Условия использования" className="border-t">
          <ConsentChecks>
            <ConsentCheck
              id="welcome-terms"
              checked={acceptTerms}
              onChange={setAcceptTerms}
              label={terms.label}
              link={terms.link}
              href={legalDocumentPath('terms', terms.version)}
            />
            {marketing && (
              <ConsentCheck
                id="welcome-marketing"
                checked={acceptMarketing}
                onChange={setAcceptMarketing}
                label={marketing.label}
                link={marketing.link}
                href={legalDocumentPath('marketing', marketing.version)}
              />
            )}
          </ConsentChecks>
        </FormSection>

        <Footer
          ready={acceptTerms}
          pending={complete.isPending}
          error={complete.isError ? humanError(complete.error) : null}
          action="Завершить регистрацию"
          onSubmit={submit}
        />
      </Card>
    </Shell>
  )
}

function UpdateForm({ terms, onDone }: { terms: Terms; onDone: () => void }) {
  const [acceptTerms, setAcceptTerms] = useState(false)
  const complete = useCompleteConsent()

  return (
    <Shell
      title="Условия использования обновились"
      description={`С ${formatDate(terms.effectiveAt)} действует новая редакция Пользовательского соглашения. Чтобы продолжить работу, примите её.`}
    >
      <Card className="gap-0 overflow-hidden py-0">
        <FormSection title="Новая редакция">
          <ConsentChecks>
            <ConsentCheck
              id="welcome-terms"
              checked={acceptTerms}
              onChange={setAcceptTerms}
              label={terms.label}
              link={terms.link}
              href={legalDocumentPath('terms', terms.version)}
            />
          </ConsentChecks>
        </FormSection>
        <Footer
          ready={acceptTerms}
          pending={complete.isPending}
          error={complete.isError ? humanError(complete.error) : null}
          action="Принять и продолжить"
          onSubmit={() =>
            complete.mutate(
              { change: { accept: [{ kind: 'terms', version: terms.version }] }, profile: null },
              { onSuccess: () => onDone() },
            )
          }
        />
      </Card>
    </Shell>
  )
}

// Shell — страница экрана: название сервиса сверху, шаг, заголовок и пояснение вне карточки.
// Фон страницы темнее карточки: на белом по белому граница карточки терялась.
function Shell({
  step,
  title,
  description,
  children,
}: {
  // step — где человек в пути регистрации; на экране новой редакции шага нет.
  step?: string
  title: React.ReactNode
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-svh bg-muted">
      <header className="mx-auto flex h-14 w-full max-w-3xl items-center px-5 sm:px-8">
        <span className="text-base font-bold tracking-tight">Trillix</span>
      </header>
      <main className="mx-auto w-full max-w-3xl px-5 pt-6 pb-16 sm:px-8">
        {step && <p className="mb-2 text-sm font-semibold text-muted-foreground">{step}</p>}
        <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
        {description && <p className="mt-2 text-base text-muted-foreground">{description}</p>}
        <div className="mt-8">{children}</div>
      </main>
    </div>
  )
}

// FormSection — раздел карточки: заголовок и содержимое.
function FormSection({
  title,
  className,
  children,
}: {
  title: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn('px-6 py-6 sm:px-8 sm:py-7', className)}>
      <h2 className="text-xl font-bold tracking-tight">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  )
}

// Footer — подвал карточки с единственным действием. Пока кнопка неактивна, слева сказано
// почему: неактивная кнопка без объяснения читается поломкой.
function Footer({
  ready,
  pending,
  error,
  action,
  onSubmit,
}: {
  ready: boolean
  pending: boolean
  error: string | null
  action: string
  onSubmit: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t bg-muted/40 px-6 py-4 sm:px-8">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{ready ? '' : 'Примите соглашение, чтобы продолжить'}</p>
      )}
      <Button size="lg" className="w-full sm:ml-auto sm:w-auto" disabled={!ready || pending} onClick={onSubmit}>
        {action}
      </Button>
    </div>
  )
}

// ConsentChecks — галочки согласий столбцом.
function ConsentChecks({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>
}

// Row — строка анкеты: подпись слева, поле справа, как на образце; колонки одной ширины у всех
// строк. На узком экране подпись уходит над полем и стоит к нему ближе, чем к соседнему
// вопросу — иначе пары «подпись — поле» не читаются.
function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-2 sm:grid-cols-2 sm:items-center sm:gap-6">{children}</div>
}

function KindRow({ value, onChange }: { value: SignupKind; onChange: (v: SignupKind) => void }) {
  const labelId = useId()
  return (
    <Row>
      <span id={labelId} className="text-sm font-semibold">
        Кто вы на нашем сервисе?
      </span>
      <Tabs value={value} onValueChange={(v) => onChange(v === 'company' ? 'company' : 'person')}>
        <TabsList aria-labelledby={labelId} className="grid w-full grid-cols-2">
          <TabsTrigger value="person">Частное лицо</TabsTrigger>
          <TabsTrigger value="company">Компания или ИП</TabsTrigger>
        </TabsList>
      </Tabs>
    </Row>
  )
}

function TextRow({
  label,
  placeholder,
  value,
  onChange,
  maxLength,
}: {
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  maxLength: number
}) {
  const id = useId()
  return (
    <Row>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
    </Row>
  )
}

function SelectRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly { value: T; label: string }[]
  value: T | null
  onChange: (v: T | null) => void
}) {
  const id = useId()
  return (
    <Row>
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? ''} onValueChange={(v) => onChange(options.find((o) => o.value === v)?.value ?? null)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Выберите из списка" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  )
}

function DocLink({ href, children }: { href: string; children: string }) {
  // В новой вкладке: документ читают, не теряя отмеченных галочек и ответов анкеты.
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
      {children}
    </a>
  )
}

// ConsentCheck — галочка с подписью от сервера; часть подписи `link` становится ссылкой
// на документ. Ссылка внутри <label> галочку не переключает: щелчок по интерактивному
// потомку метку не активирует. Подпись — основным кеглем: это условие входа, а не сноска.
function ConsentCheck({
  id,
  checked,
  onChange,
  label,
  link,
  href,
}: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  link: string
  href: string
}) {
  const at = link === '' ? -1 : label.indexOf(link)
  return (
    <div className="flex items-start gap-3">
      {/* Рамка темнее системной: на белой карточке галочка условия входа не должна
          теряться. */}
      <Checkbox
        id={id}
        className="mt-1 border-muted-foreground/60"
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <Label htmlFor={id} className="text-base leading-6 font-normal">
        {at < 0 ? (
          <span>
            {label} (<DocLink href={href}>документ</DocLink>)
          </span>
        ) : (
          <span>
            {label.slice(0, at)}
            <DocLink href={href}>{link}</DocLink>
            {label.slice(at + link.length)}
          </span>
        )}
      </Label>
    </div>
  )
}
