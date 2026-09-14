import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, Link2, RotateCw } from 'lucide-react'

import { humanError } from '../../shared/api/errors'
import { formatDateTime } from '../../shared/format'
import { Section } from '../../shared/page/Section'
import { EmptyState, ErrorState } from '../../shared/page/states'
import { joinLinkQueryOptions, useCreateJoinLink, useRevokeJoinLink } from './queries'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'

// Ссылка-приглашение — РАЗДЕЛ страницы, а не диалог по кнопке: это состояние
// пространства (она либо есть, либо нет, либо истекла), а диалоги в кабинете
// выполняют действия. Приглашения по адресу почты в продукте нет вовсе — ADR §10.
//
// Раздел рисуется только при `member.manage`: ручка стоит за этим правом, и
// знать ссылку значит уметь ею раздавать доступ.
export function JoinLinkSection({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string
  // workspaceName — в подпись к ссылке. Человек копирует её, чтобы отправить, и
  // название пространства здесь отвечает на «куда именно я его зову».
  workspaceName: string
}) {
  const link = useQuery(joinLinkQueryOptions(workspaceId, true))
  const create = useCreateJoinLink(workspaceId)
  const revoke = useRevokeJoinLink(workspaceId)
  const [revoking, setRevoking] = useState(false)

  const current = link.data ?? null
  const usable = current !== null && !current.expired

  return (
    <Section
      title="Ссылка-приглашение"
      action={
        usable && (
          <Button
            variant="outline"
            size="sm"
            disabled={create.isPending}
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: () => toast.success('Новая ссылка выписана, прежняя больше не работает.'),
                onError: (error) => toast.error(humanError(error, 'Не удалось выписать ссылку.')),
              })
            }
          >
            <RotateCw className="size-4" />
            {create.isPending ? 'Выписываем…' : 'Создать новую'}
          </Button>
        )
      }
    >
      {link.isPending && <Skeleton className="h-10 w-full rounded-lg" />}

      {link.isError && (
        <ErrorState
          title={humanError(link.error, 'Не удалось загрузить ссылку.')}
          onRetry={() => void link.refetch()}
          retryLabel="Повторить"
        />
      )}

      {/* Нет ссылки и истёкшая — РАЗНЫЕ новости, и текст у них разный: во втором
          случае человек уже кому-то её отправил, и ему важно знать, что она
          умерла, а не что её не было. */}
      {link.isSuccess && !usable && (
        <EmptyState
          icon={Link2}
          title={current === null ? 'Ссылки нет' : 'Срок ссылки истёк'}
          description={
            current === null
              ? 'Создайте ссылку и передайте её тому, кого зовёте в пространство.'
              : 'Ссылка действовала сутки и больше не пускает. Создайте новую, если человек ещё не вошёл.'
          }
          action={
            <Button
              variant="utility"
              disabled={create.isPending}
              onClick={() =>
                create.mutate(undefined, {
                  onError: (error) => toast.error(humanError(error, 'Не удалось выписать ссылку.')),
                })
              }
            >
              <Link2 className="size-4" />
              {create.isPending ? 'Создаём…' : 'Создать ссылку'}
            </Button>
          }
        />
      )}

      {link.isSuccess && usable && (
        <div className="flex flex-col gap-2">
          {/* Подпись живёт РЯДОМ СО ССЫЛКОЙ, а не пояснением раздела: раздел
              стоит на экране и когда ссылки нет, и «отправьте эту ссылку» там
              было бы неправдой. */}
          <p className="text-sm text-muted-foreground">
            Отправьте её тому, кого зовёте в «{workspaceName}» — он станет редактором.
          </p>
          <div className="flex flex-wrap gap-2">
            {/* readOnly-инпут, а не <pre>: ссылку выделяют и копируют руками не
                реже, чем кнопкой, и поле даёт для этого привычный контрол. */}
            <Input
              readOnly
              value={current.url}
              aria-label="Ссылка-приглашение"
              className="min-w-48 flex-1"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button variant="utility" onClick={() => void copyLink(current.url)}>
              <Copy className="size-4" />
              Копировать
            </Button>
            {/* Деструктивное — последним местом и приглушением (DESIGN-SYSTEM §7):
                отделять его в ряду больше нечем, разделителей у кнопок нет. */}
            <Button
              variant="ghost"
              className="text-destructive hover:bg-destructive/8 hover:text-destructive"
              onClick={() => setRevoking(true)}
            >
              Отключить
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Действует до {formatDateTime(current.expiresAt)}
          </p>
        </div>
      )}

      <AlertDialog open={revoking} onOpenChange={setRevoking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отключить ссылку?</AlertDialogTitle>
            <AlertDialogDescription>
              Она перестанет пускать немедленно — у всех, кому вы её уже передали. Те, кто успел
              войти, останутся в пространстве.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revoke.isError && (
            <p role="alert" className="text-sm text-destructive">
              {humanError(revoke.error, 'Не удалось отключить ссылку. Попробуйте ещё раз.')}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={revoke.isPending}
              onClick={(e) => {
                // Окно закрывается по УСПЕХУ, а не по клику: отказ сервера иначе
                // остался бы за закрытым окном, и ссылка выглядела бы погашенной.
                e.preventDefault()
                revoke.mutate(undefined, { onSuccess: () => setRevoking(false) })
              }}
            >
              {revoke.isPending ? 'Отключаем…' : 'Отключить'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

// Копирование через буфер обмена браузера. Отказ возможен и законен (нет прав,
// небезопасный контекст), поэтому он не молчит: человеку тогда остаётся выделить
// поле руками, и сказать ему об этом надо.
async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    toast.success('Ссылка скопирована.')
  } catch {
    toast.error('Не удалось скопировать. Выделите ссылку в поле и скопируйте вручную.')
  }
}
