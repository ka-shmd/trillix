import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { DeleteAccountSection } from '../../features/auth/account/DeleteAccountSection'
import { ProfileSection } from '../../features/auth/account/ProfileSection'
import { SignInSection } from '../../features/auth/account/SignInSection'
import { DevicesSection, TwoFactorSection } from '../../features/auth/account/TwoFactorSection'
import { meQueryOptions } from '../../features/auth/queries'
import { SignupProfileSection } from '../../features/legal/SignupProfileSection'
import { PageCrumbs } from '../../shared/page/headerPortals'
import { PageContainer } from '../../shared/page/PageContainer'
import { PageHeader } from '../../shared/page/PageHeader'

// Страница «Аккаунт» (/settings/account): профиль, способы входа, второй фактор
// и удаление аккаунта (docs/design/account-settings.md).
//
// РАЗДЕЛЫ ИДУТ ОТ «КТО Я» К «КАК Я ВХОЖУ» И ЗАКАНЧИВАЮТСЯ НЕОБРАТИМЫМ. Пароль
// жил отдельным разделом и повторялся строкой в списке способов входа.
//
// ⚠ РАЗДЕЛА «АДРЕС АККАУНТА» ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ (решение владельца
// 2026-09-08): почта и есть аккаунт, связь железная, механизма смены адреса в
// продукте не существует ни на одном слое. Адрес показан строкой в «Профиле».
//
// link — исход возврата от провайдера после привязки. Колбэк это навигация
// браузера, а не вызов API: сказать «получилось» он может только параметром
// адреса. Мусор гасит catch — правка адреса руками не должна ронять экран.
const accountSearchSchema = z.object({
  link: z.enum(['ok', 'conflict', 'expired', 'failed']).optional().catch(undefined),
})

export const Route = createFileRoute('/_app/settings/account')({
  validateSearch: accountSearchSchema,
  component: AccountPage,
})

function AccountPage() {
  // Профиль уже в кэше — его положил гард _app; отдельного состояния загрузки
  // здесь быть не может.
  const { data: user } = useQuery(meQueryOptions)
  const { link } = Route.useSearch()
  const navigate = Route.useNavigate()
  if (!user) return null

  return (
    <PageContainer>
      <PageCrumbs items={['Аккаунт']} />
      <PageHeader
        title="Аккаунт"
        description="Как вас зовут в кабинете, как вы в него входите и что защищает вход."
      />

      <div className="mt-8 flex flex-col gap-16">
        {/* key по id: смена личности в той же вкладке (вход другим аккаунтом)
            обязана сбрасывать черновик имени, иначе форма покажет имя предыдущего
            пользователя. Ремаунтом, а не эффектом-синхронизатором: setState в теле
            эффекта запрещён линтом (react-hooks/set-state-in-effect) и даёт
            каскадный ререндер. */}
        <ProfileSection key={user.id} user={user} />
        {/* Анкета регистрации живёт в фиче legal, а собирает страницу маршрут: импорт одной
            фичи из другой запрещён (web/CLAUDE.md). */}
        <SignupProfileSection />
        <SignInSection
          user={user}
          link={link}
          onLinkOutcome={(outcome) =>
            void navigate({ to: '/settings/account', search: { link: outcome } })
          }
          onLinkClear={() => void navigate({ to: '/settings/account', search: {} })}
        />
        <TwoFactorSection user={user} />
        {/* Устройства существуют только при включённом факторе: бэк забывает их
            при выключении. */}
        {user.twoFactorEnabled && <DevicesSection />}
        <DeleteAccountSection user={user} onDeleted={() => void navigate({ to: '/login' })} />
      </div>
    </PageContainer>
  )
}
