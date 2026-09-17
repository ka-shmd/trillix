import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { consentsQueryOptions, useCompleteConsent } from './queries'
import {
  legalDocumentPath,
  SIGNUP_KINDS,
  SIGNUP_PURPOSES,
  SIGNUP_REFERRALS,
  profileOf,
  type Consents,
  type ConsentChange,
  type SignupProfile,
} from '../../entities/legal'
import { humanError } from '../../shared/api/errors'
import { formatDate } from '../../shared/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'

// Экран согласия (docs/design/signup-consent.md §3.3). Два варианта по ответу сервера:
// «Завершение регистрации» — соглашение, согласие на рассылки и анкета; «Условия
// использования обновились» — только соглашение. Пока галочка соглашения не отмечена,
// ни одна кнопка, которая ведёт в кабинет, не нажимается.

interface Props {
  email: string
  // onDone — согласие принято: маршрут возвращает человека туда, куда он шёл.
  onDone: () => void
  onLogout: () => void
  logoutPending: boolean
}

export function WelcomeScreen({ email, onDone, onLogout, logoutPending }: Props) {
  const consents = useQuery(consentsQueryOptions)
  const screen = consents.data?.screen

  // Согласие уже дано (в соседней вкладке или экран открыт по устаревшему кэшу me) —
  // держать человека здесь незачем.
  useEffect(() => {
    if (consents.data && screen === null) onDone()
  }, [consents.data, screen, onDone])

  if (consents.isPending) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <Skeleton className="h-6 w-56" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </CardContent>
      </Card>
    )
  }
  // Без действующей редакции соглашения гейт не закрывается вовсе — сюда это доезжает
  // только сбоем, и показывается как сбой.
  if (consents.isError || !consents.data.terms) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Не удалось загрузить условия</CardTitle>
          <CardDescription>{humanError(consents.error)}</CardDescription>
        </CardHeader>
        <CardFooter className="flex justify-between gap-2">
          <Button variant="ghost" onClick={onLogout} disabled={logoutPending}>
            Выйти
          </Button>
          <Button onClick={() => void consents.refetch()}>Попробовать ещё раз</Button>
        </CardFooter>
      </Card>
    )
  }
  const { data } = consents
  const { terms } = data
  if (data.screen === null || !terms) return null

  return (
    <ConsentForm
      consents={data}
      terms={terms}
      variant={data.screen}
      email={email}
      onDone={onDone}
      onLogout={onLogout}
      logoutPending={logoutPending}
    />
  )
}

function ConsentForm({
  consents,
  terms,
  variant,
  email,
  onDone,
  onLogout,
  logoutPending,
}: Omit<Props, 'email'> & {
  consents: Consents
  terms: NonNullable<Consents['terms']>
  variant: 'signup' | 'update'
  email: string
}) {
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [acceptMarketing, setAcceptMarketing] = useState(false)
  const [answers, setAnswers] = useState<SignupProfile>({ kind: null, purpose: null, referral: null })
  const complete = useCompleteConsent()
  const marketing = variant === 'signup' ? consents.marketing : null

  const submit = (withProfile: boolean) => {
    const change: ConsentChange = { accept: [{ kind: 'terms', version: terms.version }] }
    if (marketing && acceptMarketing) change.accept?.push({ kind: 'marketing', version: marketing.version })
    complete.mutate(
      { change, profile: withProfile ? profileOf(answers) : null },
      { onSuccess: () => onDone() },
    )
  }
  const blocked = !acceptTerms || complete.isPending

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-xl">
          {variant === 'signup' ? 'Завершение регистрации' : 'Условия использования обновились'}
        </CardTitle>
        <CardDescription>
          {variant === 'signup'
            ? 'Остался последний шаг — примите условия использования Trillix.'
            : `Новая редакция Пользовательского соглашения действует с ${formatDate(terms.effectiveAt)}. Чтобы продолжить работу, примите её.`}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {variant === 'signup' && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="welcome-email">Email</Label>
            <Input id="welcome-email" value={email} readOnly />
          </div>
        )}

        <div className="flex flex-col gap-3">
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
          <p className="text-sm text-muted-foreground">
            Как мы обрабатываем данные —{' '}
            <DocLink href={legalDocumentPath('privacy')}>Политика обработки персональных данных</DocLink>
          </p>
        </div>

        {variant === 'signup' && (
          <>
            <Separator />
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-sm font-semibold">Расскажите о себе</p>
                <p className="text-sm text-muted-foreground">
                  Необязательно — так мы поймём, что улучшать в первую очередь.
                </p>
              </div>
              <Question
                id="welcome-kind"
                label="Кто вы?"
                options={SIGNUP_KINDS}
                value={answers.kind}
                onChange={(kind) => setAnswers((a) => ({ ...a, kind }))}
              />
              <Question
                id="welcome-purpose"
                label="Для чего будете использовать Trillix?"
                options={SIGNUP_PURPOSES}
                value={answers.purpose}
                onChange={(purpose) => setAnswers((a) => ({ ...a, purpose }))}
              />
              <Question
                id="welcome-referral"
                label="Как вы о нас узнали?"
                options={SIGNUP_REFERRALS}
                value={answers.referral}
                onChange={(referral) => setAnswers((a) => ({ ...a, referral }))}
              />
            </div>
          </>
        )}

        {complete.isError && (
          <p role="alert" className="text-sm text-destructive">
            {humanError(complete.error)}
          </p>
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" onClick={onLogout} disabled={logoutPending}>
          Выйти
        </Button>
        {variant === 'signup' ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={blocked} onClick={() => submit(false)}>
              Пропустить
            </Button>
            <Button disabled={blocked} onClick={() => submit(true)}>
              Завершить регистрацию
            </Button>
          </div>
        ) : (
          <Button disabled={blocked} onClick={() => submit(false)}>
            Принять
          </Button>
        )}
      </CardFooter>
    </Card>
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
// потомку метку не активирует.
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
    <div className="flex items-start gap-2">
      <Checkbox id={id} className="mt-0.5" checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="leading-5 font-normal">
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

function Question<T extends string>({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string
  label: string
  options: readonly { value: T; label: string }[]
  value: T | null
  onChange: (v: T | null) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? ''}
        onValueChange={(v) => onChange((options.find((o) => o.value === v)?.value ?? null) as T | null)}
      >
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
    </div>
  )
}
