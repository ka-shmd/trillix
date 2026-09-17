import { createFileRoute } from '@tanstack/react-router'

import { LegalSettings } from '../../features/legal/LegalSettings'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'

// «Правовая информация» (/settings/legal): документы сервиса, рассылки и история
// согласий аккаунта (docs/design/signup-consent.md §3.7). Пункт панели, крошка и
// заголовок называют страницу одинаково (docs/DESIGN-SYSTEM.md §3).
export const Route = createFileRoute('/_app/settings/legal')({
  component: LegalSettingsPage,
})

function LegalSettingsPage() {
  return (
    <PageContainer>
      <PageCrumbs items={['Правовая информация']} />
      <PageHeader
        wrapTitle
        title="Правовая информация"
        description="Документы Trillix, рассылки и то, с чем вы соглашались."
      />
      <LegalSettings />
    </PageContainer>
  )
}
