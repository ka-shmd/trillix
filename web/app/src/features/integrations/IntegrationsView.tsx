import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Table2 } from 'lucide-react'

import type { FormIntegrations, FormSheet } from '../../entities/integration'
import { GoogleSheetsOverlay } from './GoogleSheetsOverlay'
import { formIntegrationsQueryOptions } from './queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

// Экран «Интеграции» формы — СПИСОК, а не простыня настроек: интеграций будет
// много (вебхук, Telegram), у каждой свои поля, и инлайн они превратили бы экран
// в кашу. Настройки живут в полноэкранном оверлее, который открывается кликом по
// строке, — это общий жест продукта для всех интеграций, а не особенность
// Таблиц.
//
// Заглушек «скоро будет» здесь нет: они обещают срок, которого никто не давал.
export function IntegrationsView({ formId }: { formId: string }) {
  const state = useQuery(formIntegrationsQueryOptions(formId))
  const [open, setOpen] = useState(false)

  if (state.isPending) {
    return <p className="text-sm text-muted-foreground">Загрузка…</p>
  }
  if (state.isError || !state.data) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <p className="mb-3 text-sm">Не удалось загрузить интеграции.</p>
        <Button variant="outline" size="sm" onClick={() => state.refetch()}>
          Повторить
        </Button>
      </div>
    )
  }

  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Ответы этой формы могут уезжать во внешние сервисы сами — сразу после отправки.
      </p>

      <ul className="flex flex-col gap-2">
        <li>
          {/* Вся строка — кнопка: попадать нужно в неё целиком, а не в мелкую
              ссылку справа. Внутри кнопки живут только текст и значки. */}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex w-full items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted/50"
          >
            <Table2 className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Google Таблицы</span>
              <span className="block text-sm text-muted-foreground">
                {summary(state.data)}
              </span>
            </span>
            {state.data.sheet && <StatusBadge status={state.data.sheet.status} />}
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </li>
      </ul>

      {open && (
        <GoogleSheetsOverlay formId={formId} state={state.data} onClose={() => setOpen(false)} />
      )}
    </section>
  )
}

// summary — вторая строка карточки: состояние одной фразой. Она отвечает на
// «что сейчас», а не рекламирует возможность: «не настроено на контуре» ≠ «не
// подключено» ≠ «подключено, но форма не привязана» — это три разных ответа, и
// смешивать их значит советовать нажать кнопку, которой не появится.
function summary(state: FormIntegrations): string {
  if (!state.account.enabled) return 'На этом контуре интеграция не настроена'
  if (state.sheet) {
    return state.sheet.name || `Каждый ответ ложится строкой в таблицу · ${state.account.email}`
  }
  if (state.account.connected) return `Подключено как ${state.account.email} — выберите таблицу`
  return 'Каждый ответ ложится строкой в таблицу на вашем Google Диске'
}

function StatusBadge({ status }: { status: FormSheet['status'] }) {
  if (status === 'broken') return <Badge variant="destructive">Сломана</Badge>
  if (status === 'backfilling') return <Badge variant="secondary">Переносим</Badge>
  return <Badge variant="outline">Работает</Badge>
}
