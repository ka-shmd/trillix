import { useQuery } from '@tanstack/react-query'

import { consentsQueryOptions, documentsQueryOptions, useApplyConsents } from './queries'
import {
  consentKindSchema,
  consentSourceLabel,
  editionIso,
  legalDocumentPath,
} from '../../entities/legal'
import { humanError } from '../../shared/api/errors'
import { formatDate, formatDateTime } from '../../shared/format'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

// «Правовая информация» в кабинете (docs/design/signup-consent.md §3.7): документы
// сервиса, решение о рассылках и история согласий аккаунта со ссылками на ту самую
// редакцию, с которой человек соглашался.

function DocLink({ href, children }: { href: string; children: React.ReactNode }) {
  // Документы — публичные страницы вне кабинета: в новой вкладке, чтобы не выходить из него.
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
      {children}
    </a>
  )
}

export function LegalSettings() {
  const consents = useQuery(consentsQueryOptions)
  const docs = useQuery(documentsQueryOptions)
  const apply = useApplyConsents()

  return (
    <div className="mt-8 flex flex-col gap-16">
      <Section title="Документы" description="Действующие редакции документов сервиса.">
        {docs.isPending && <LoadingRows rows={3} />}
        {docs.isError && <ErrorState onRetry={() => void docs.refetch()} />}
        {docs.data && (
          <ul className="divide-y border-t">
            {docs.data.map((d) => (
              <li key={d.kind} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-4">
                <span className="text-base font-semibold">
                  <DocLink href={legalDocumentPath(d.kind)}>{d.title}</DocLink>
                </span>
                <span className="text-sm text-muted-foreground">Действует с {formatDate(d.effectiveAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {consents.isPending && <LoadingRows rows={2} />}
      {consents.isError && <ErrorState onRetry={() => void consents.refetch()} />}
      {consents.data?.marketing && (
        <Section title="Рассылки">
          <div className="flex items-start justify-between gap-6 border-t py-4">
            <div className="min-w-0">
              <Label htmlFor="marketing-switch" className="text-base font-semibold">
                {consents.data.marketing.toggleLabel}
              </Label>
              <p className="mt-1 text-sm text-muted-foreground">
                {consents.data.marketing.granted && consents.data.marketing.changedAt
                  ? `Включены с ${formatDate(consents.data.marketing.changedAt)}.`
                  : 'Выключены.'}{' '}
                Письма о новых функциях, тарифах и предложениях по{' '}
                <DocLink href={legalDocumentPath('marketing', consents.data.marketing.version)}>
                  согласию на рассылки
                </DocLink>
                . Коды входа и уведомления об ответах приходят в любом случае.
              </p>
              {apply.isError && (
                <p role="alert" className="mt-1 text-sm text-destructive">
                  {humanError(apply.error)}
                </p>
              )}
            </div>
            {/* Тумблер выровнен по первой строке подписи, а не по центру блока: у строки с
                длинным пояснением центр уезжает вниз. */}
            <Switch
              id="marketing-switch"
              className="mt-1"
              checked={consents.data.marketing.granted}
              disabled={apply.isPending}
              onCheckedChange={(on) => {
                const marketing = consents.data.marketing
                if (!marketing) return
                apply.mutate(
                  on ? { accept: [{ kind: 'marketing', version: marketing.version }] } : { withdraw: ['marketing'] },
                )
              }}
            />
          </div>
        </Section>
      )}

      {consents.data && (
        <Section title="Ваши согласия" description="Что и когда вы принимали — со ссылкой на ту самую редакцию.">
          {consents.data.history.length === 0 ? (
            <EmptyState title="Согласий пока нет" />
          ) : (
            <ul className="divide-y border-t">
              {consents.data.history.map((h) => {
                const kind = consentKindSchema.safeParse(h.kind)
                return (
                  <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-4">
                    <div className="min-w-0">
                      <p className="text-base font-semibold">
                        {h.action === 'accepted' ? 'Принято' : 'Отозвано'}:{' '}
                        {kind.success ? (
                          <DocLink href={legalDocumentPath(kind.data, h.version)}>{h.title}</DocLink>
                        ) : (
                          h.title
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Редакция от {formatDate(editionIso(h.version))} · {consentSourceLabel(h.source)}
                      </p>
                    </div>
                    <span className="text-sm text-muted-foreground">{formatDateTime(h.at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>
      )}
    </div>
  )
}
