import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { consentsQueryOptions, useCompleteConsent } from './queries'
import { SignupFields } from './signupFields'
import {
  emptySignupDraft,
  legalDocumentPath,
  signupProfileOf,
  type ConsentChange,
  type Consents,
  type SignupDraft,
} from '../../entities/legal'
import { humanError } from '../../shared/api/errors'
import { formatDate } from '../../shared/format'
import { ErrorState } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
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
  //
  // Мина: только по СВЕЖЕМУ ответу. Кэш согласий держит баннер новой редакции на каждой
  // странице кабинета, и на отданном из него `screen: null` экран увёл бы человека обратно в
  // кабинет, откуда гард вернул бы его сюда, — и так по кругу, пока не приедет ответ сервера.
  useEffect(() => {
    if (consents.data && screen === null && !consents.isFetching) onDone()
  }, [consents.data, screen, consents.isFetching, onDone])

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
          <SignupFields draft={draft} onChange={setDraft} />
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

// ConsentChecks — галочки согласий и ссылка на политику под ними: политика обязана быть
// доступна там, где собираются данные (ч. 2 ст. 18.1 152-ФЗ), а анкета собирает ФИО и
// организацию.
function ConsentChecks({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      {children}
      <p className="text-sm">
        <DocLink href={legalDocumentPath('privacy')}>Политика обработки персональных данных</DocLink>
      </p>
    </div>
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
