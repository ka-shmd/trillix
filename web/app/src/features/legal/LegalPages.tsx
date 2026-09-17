import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { documentQueryOptions, documentsQueryOptions } from './queries'
import { docBlocks, SERVICE_OPERATOR, type ConsentKind } from '../../entities/legal'
import { ApiError } from '../../shared/api/errors'
import { formatDate } from '../../shared/format'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Skeleton } from '@/components/ui/skeleton'

// Публичные страницы документов сервиса (docs/design/signup-consent.md §3.7). Открываются
// без входа — политику обязаны видеть там, где собираются данные (ч. 2 ст. 18.1 152-ФЗ),
// — поэтому живут вне оболочки кабинета: без сайдбара и крошек, в колонке для чтения.

function LegalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh bg-background">
      {/* Полоса повторяет колонку страницы (narrow = max-w-2xl): название сервиса и вход
          в оглавление стоят над текстом, а не над краями экрана. */}
      <header className="border-b">
        <div className="mx-auto flex h-12 w-full max-w-2xl items-center justify-between px-5 sm:px-8">
          <Link to="/" className="text-base font-bold tracking-tight">
            Trillix
          </Link>
          <Link to="/legal" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Правовая информация
          </Link>
        </div>
      </header>
      <PageContainer width="narrow">{children}</PageContainer>
    </div>
  )
}

export function LegalIndexPage() {
  const docs = useQuery(documentsQueryOptions)

  return (
    <LegalShell>
      <PageHeader title="Правовая информация" description="Документы сервиса Trillix и кому писать." />
      <div className="mt-12 flex flex-col gap-12">
        <Section title="Документы">
          {docs.isPending && <LoadingRows rows={3} />}
          {docs.isError && <ErrorState onRetry={() => void docs.refetch()} />}
          {docs.data && (
            <ul className="divide-y border-t">
              {docs.data.map((d) => (
                <li key={d.kind} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-4">
                  <Link
                    to="/legal/$kind"
                    params={{ kind: d.kind }}
                    className="text-base font-semibold text-primary underline-offset-4 hover:underline"
                  >
                    {d.title}
                  </Link>
                  <span className="text-sm text-muted-foreground">Действует с {formatDate(d.effectiveAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Оператор">
          <div className="flex flex-col gap-1 text-base">
            <p className="font-semibold">{SERVICE_OPERATOR.name}</p>
            {SERVICE_OPERATOR.details.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </Section>

        <Section title="Обращения">
          <div className="flex flex-col gap-2 text-base">
            <p>
              Вопросы об обработке персональных данных, отзыв согласия и жалобы на формы —{' '}
              {SERVICE_OPERATOR.privacyEmail}.
            </p>
            <p>Претензии по Пользовательскому соглашению — {SERVICE_OPERATOR.legalEmail}.</p>
          </div>
        </Section>
      </div>
    </LegalShell>
  )
}

export function LegalDocumentPage({ kind, version }: { kind: ConsentKind; version: string }) {
  const doc = useQuery(documentQueryOptions(kind, version))

  if (doc.isPending) {
    return (
      <LegalShell>
        <Skeleton className="h-9 w-3/4" />
        <div className="mt-8 flex flex-col gap-3">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      </LegalShell>
    )
  }
  if (doc.isError) {
    return (
      <LegalShell>
        {doc.error instanceof ApiError && doc.error.code === 'not_found' ? (
          <EmptyState
            title="Такой редакции нет"
            description="Возможно, ссылка неточная."
            action={
              <Link to="/legal" className="text-sm text-primary underline-offset-4 hover:underline">
                Все документы
              </Link>
            }
          />
        ) : (
          <ErrorState title="Не удалось загрузить документ." onRetry={() => void doc.refetch()} />
        )}
      </LegalShell>
    )
  }

  const d = doc.data
  const current = d.versions[0]?.version
  const isCurrent = d.version === current

  return (
    <LegalShell>
      <PageHeader
        title={d.title}
        description={
          isCurrent
            ? `Действует с ${formatDate(d.effectiveAt)}`
            : `Редакция, действовавшая с ${formatDate(d.effectiveAt)}`
        }
      />
      {!isCurrent && (
        <p className="mt-6 rounded-lg bg-muted p-4 text-sm">
          Это прежняя редакция.{' '}
          <Link
            to="/legal/$kind"
            params={{ kind }}
            className="text-primary underline-offset-4 hover:underline"
          >
            Открыть действующую
          </Link>
        </p>
      )}

      <article className="mt-8 flex flex-col gap-4">
        {docBlocks(d.text).map((b, i) =>
          b.kind === 'heading' ? (
            <h2 key={i} className="mt-4 text-xl font-bold tracking-tight">
              {b.text}
            </h2>
          ) : (
            <p key={i} className="text-base leading-7 whitespace-pre-line">
              {b.text}
            </p>
          ),
        )}
      </article>

      {d.versions.length > 1 && (
        <Section title="Редакции" className="mt-16">
          <ul className="divide-y border-t">
            {d.versions.map((v) => {
              const label = `${v.version === current ? 'Действует' : 'Действовала'} с ${formatDate(v.effectiveAt)}`
              return (
                <li key={v.version} className="py-3">
                  {v.version === d.version ? (
                    <span className="text-base font-semibold">{label} — открыта</span>
                  ) : (
                    <Link
                      to="/legal/$kind"
                      params={{ kind }}
                      search={{ version: v.version }}
                      className="text-base text-primary underline-offset-4 hover:underline"
                    >
                      {label}
                    </Link>
                  )}
                </li>
              )
            })}
          </ul>
        </Section>
      )}
    </LegalShell>
  )
}
