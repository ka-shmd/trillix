import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText, X } from 'lucide-react'

import { consentsQueryOptions } from './queries'
import { legalDocumentPath } from '../../entities/legal'
import { formatDate } from '../../shared/format'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

// Баннер несущественной редакции соглашения (docs/design/signup-consent.md §3.7): вышла
// редакция, не закрывающая кабинет, а принята прежняя. Существенную показывает не баннер,
// а экран согласия — туда уводит гейт.
//
// Закрытие помнит браузер, по версии редакции: следующая редакция баннер вернёт. Не на
// сервере — это удобство одного экрана, а не решение, которое нужно доказывать.
const DISMISSED_KEY = 'trillix.termsBanner.dismissed'

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

function writeDismissed(version: string) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, version)
  } catch {
    // хранилище недоступно (приватный режим) — баннер закроется до перезагрузки
  }
}

export function TermsUpdateBanner() {
  const consents = useQuery({ ...consentsQueryOptions, staleTime: 30 * 60 * 1000 })
  const [dismissed, setDismissed] = useState(readDismissed)
  const terms = consents.data?.terms

  if (!consents.data || consents.data.screen !== null || !terms) return null
  if (terms.acceptedVersion === null || terms.acceptedVersion === terms.version) return null
  if (dismissed === terms.version) return null

  return (
    <Alert className="relative mx-4 mt-4 w-auto pr-12">
      <FileText />
      <AlertTitle>Условия использования обновились</AlertTitle>
      <AlertDescription>
        <p>
          С {formatDate(terms.effectiveAt)} действует новая редакция Пользовательского соглашения.{' '}
          <a
            href={legalDocumentPath('terms', terms.version)}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            Прочитать
          </a>
        </p>
      </AlertDescription>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 size-8 text-muted-foreground"
        onClick={() => {
          writeDismissed(terms.version)
          setDismissed(terms.version)
        }}
      >
        <X className="size-4" />
        <span className="sr-only">Закрыть</span>
      </Button>
    </Alert>
  )
}
