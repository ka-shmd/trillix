import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'

import {
  recallWorkspaceSlug,
  rememberWorkspaceSlug,
  workspaceSlugFromPath,
} from './currentWorkspace'

// Оболочка кабинета (переключатель в сайдбаре, крошки, гейты тарифа) обязана знать,
// в каком пространстве стоит человек. Знание приходит из двух мест, и порядок между
// ними жёсткий:
//
//   1. ПУТЬ `/w/{slug}/…` — разделы пространства. Умолчать пространство путь не может.
//   2. ЗАЯВЛЕНИЕ ФОРМЫ — экраны формы адресуются `/forms/{slug}/…` и пространства в
//      пути не несут. Форма знает его сама: `GET /forms/{id}` отдаёт `workspaceSlug`
//      с фазы 27. Повторить этот факт в адресе значило бы завести второй источник,
//      способный разойтись с первым (`/w/A/forms/f1` на форму из B синтаксически
//      безупречна и семантически ложна) — спека §3.2.
//   3. ПАМЯТЬ БРАУЗЕРА, а за ней личное пространство — пробел на экранах, которые
//      пространству не принадлежат (настройки аккаунта). По ним ничего не
//      создаётся, см. `currentWorkspace.ts`.
//
// Заявление едет ЧЕРЕЗ КОНТЕКСТ, а не импортом: сайдбар живёт над деревом маршрутов,
// а деталь формы — хозяйство фичи форм, и импорт фичи из фичи запрещён
// (`web/CLAUDE.md`). Тот же приём и та же причина, что у `AppChromeContext`: узел
// кладёт оболочка, наполняет — страница, которая владеет данными.
interface WorkspaceAddress {
  // slug текущего пространства; '' — «в адресе не сказано», то есть личное.
  slug: string
  // Названо ли пространство адресом или формой (в отличие от памяти браузера).
  // По названному и не найденному в списке действовать нельзя — см.
  // `features/workspaces/current.ts`.
  named: boolean
  declare: (slug: string | null) => void
}

const WorkspaceAddressContext = createContext<WorkspaceAddress>({
  slug: '',
  named: false,
  declare: () => {},
})

export function WorkspaceAddressProvider({
  personalSlug,
  children,
}: {
  // Куда отступить, когда пространство не названо ничем. Отдаёт маршрут `_app`:
  // список пространств — хозяйство фичи, а `shared/` в фичи не ходит. `null` —
  // список ещё едет.
  personalSlug: string | null
  children: React.ReactNode
}) {
  const fromPath = useRouterState({ select: (s) => workspaceSlugFromPath(s.location.pathname) })
  const [declared, setDeclared] = useState<string | null>(null)
  const [remembered, setRemembered] = useState<string | null>(() => recallWorkspaceSlug())

  const named = fromPath ?? declared

  // Правка состояния ПРЯМО В РЕНДЕРЕ (React, «adjusting state when props change») —
  // тот же приём, что у мишени редактора (`features/forms/draft.ts`): к моменту, когда
  // пространство перестанет называться адресом, память обязана быть уже верной, а
  // отложенный до эффекта апдейт успел бы отдать переключателю прошлое место.
  //
  // Запоминается только НАЗВАННОЕ: память, дописывающая саму себя, никогда бы не
  // протухла и пережила бы удаление пространства.
  if (named !== null && named !== remembered) setRemembered(named)

  const slug = named ?? remembered ?? personalSlug ?? ''

  // Запись в хранилище — побочный эффект, и он остаётся в эффекте: рендер обязан быть
  // чистым, а StrictMode прогоняет его дважды.
  useEffect(() => {
    if (remembered !== null) rememberWorkspaceSlug(remembered)
  }, [remembered])

  const declare = useCallback((next: string | null) => {
    // Заявление ставится в эффекте страницы, поэтому равное значение обязано быть
    // no-op: иначе каждый рендер формы дёргал бы стейт оболочки.
    setDeclared((prev) => (prev === next ? prev : next))
  }, [])

  const value = useMemo(() => ({ slug, named: named !== null, declare }), [slug, named, declare])

  return (
    <WorkspaceAddressContext.Provider value={value}>{children}</WorkspaceAddressContext.Provider>
  )
}

export function useWorkspaceAddress(): Omit<WorkspaceAddress, 'declare'> {
  const { slug, named } = useContext(WorkspaceAddressContext)
  return { slug, named }
}

// Страница формы сообщает оболочке пространство, прочитанное из самой формы.
// `undefined` = «деталь ещё едет»: прошлое заявление при этом не сбрасывается,
// иначе переключатель мигал бы личным на каждом переходе между табами формы.
export function useDeclareWorkspace(slug: string | undefined): void {
  const { declare } = useContext(WorkspaceAddressContext)
  useEffect(() => {
    if (slug === undefined || slug === '') return
    declare(slug)
    // Ушли с формы — заявление снимается. Путь при этом уже назвал пространство сам
    // либо не назвал ничего, и тогда отвечает память браузера.
    return () => declare(null)
  }, [slug, declare])
}
