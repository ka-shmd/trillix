import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { LayoutTemplate, MoreHorizontal, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

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
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { type FormTemplate } from '../../../entities/template'
import { EmptyState, ErrorState, LoadingRows } from '../../../shared/page/states'
import { TemplateDialog } from './TemplateDialog'
import { TemplateThumb } from './TemplateSheet'
import { useCreateFormFromTemplate, useDeleteTemplate, useTemplates } from './queries'

// Галерея шаблонов: витрина сервиса и шаблоны пространства двумя вкладками.
//
// ПЛИТКА — ЭТО ПРЕВЬЮ ФОРМЫ (решение владельца 2026-09-08). До этого карточка
// перечисляла первые четыре вопроса строчками «· Как вас зовут?» — то есть отвечала
// на «про что шаблон» текстом там, где ответ есть картинкой; дизайн-система прямо
// называет такую карточку строкой в три этажа (DESIGN-SYSTEM §7).
//
// workspaceId — куда положить форму из шаблона и чьи шаблоны показать на вкладке
// «Мои» (undefined = личное либо «ещё не знаем», см. маршрут). Приезжает пропом, а
// не читается отсюда: текущее пространство резолвит фича пространств, а импорт фичи
// из фичи запрещён (web/CLAUDE.md) — связывает их маршрут.
export function TemplatesView({
  workspaceId,
  workspaceSlug,
}: {
  workspaceId?: string
  workspaceSlug: string
}) {
  const navigate = useNavigate()
  const templates = useTemplates(workspaceId)
  const create = useCreateFormFromTemplate()
  const [opened, setOpened] = useState<FormTemplate | null>(null)

  function use(template: FormTemplate) {
    create.mutate(
      { templateId: template.id, workspaceId },
      {
        onSuccess: (form) =>
          navigate({
            to: '/w/$workspaceSlug/forms/$slug/edit',
            params: { workspaceSlug, slug: form.slug },
          }),
      },
    )
  }

  if (templates.isPending) return <LoadingRows className="mt-8" rows={2} />
  if (templates.isError) {
    return (
      <ErrorState
        className="mt-8"
        title="Не удалось загрузить шаблоны."
        onRetry={() => void templates.refetch()}
      />
    )
  }

  const items = templates.data.items
  const own = items.filter((t) => t.visibility === 'private')
  const shared = items.filter((t) => t.visibility === 'public')

  return (
    <>
      {/* ВКЛАДКИ, А НЕ ДВА РАЗДЕЛА ПОДРЯД: плитки высокие, и два списка на одном
          экране означали бы полтора экрана прокрутки там, где выбирают один
          шаблон. Первой стоит витрина — на ней шаблоны есть у всякого, тогда как
          «Мои» у нового пространства пусты. */}
      <Tabs defaultValue="public" className="mt-8 gap-6">
        <TabsList variant="line" className="h-auto p-0">
          <TabsTrigger value="public" className="px-1.5">
            Публичные
          </TabsTrigger>
          <TabsTrigger value="own" className="px-1.5">
            Мои
          </TabsTrigger>
        </TabsList>
        <TabsContent value="public">
          {shared.length === 0 ? (
            <EmptyState
              icon={LayoutTemplate}
              title="Публичных шаблонов пока нет"
              description="Здесь появятся готовые заготовки — их добавляет команда сервиса."
            />
          ) : (
            <Grid items={shared} onOpen={setOpened} />
          )}
        </TabsContent>
        <TabsContent value="own">
          {own.length === 0 ? (
            <EmptyState
              icon={LayoutTemplate}
              title="Своих шаблонов пока нет"
              description="Откройте меню любой формы и выберите «Сохранить как шаблон» — она встанет сюда и будет видна всем в этом пространстве."
            />
          ) : (
            <Grid items={own} onOpen={setOpened} />
          )}
        </TabsContent>
      </Tabs>

      <TemplateDialog
        template={opened}
        onOpenChange={(open) => !open && setOpened(null)}
        onUse={use}
        pending={create.isPending}
        failed={create.isError && create.variables?.templateId === opened?.id}
      />
    </>
  )
}

function Grid({
  items,
  onOpen,
}: {
  items: FormTemplate[]
  onOpen: (template: FormTemplate) => void
}) {
  return (
    // ЧИСЛО КОЛОНОК ЗАДАНО, А НЕ ВЫЧИСЛЕНО ИЗ ШИРИНЫ ПЛИТКИ (решение владельца
    // 2026-09-08: плитки широкие, в ряду их мало). Потолок — три; на широком
    // мониторе плитка растёт, а не появляется четвёртая, и вместе с плиткой растёт
    // масштаб миниатюры: у экрана 16:9 читаемость вопросов держится именно шириной.
    // `auto-fill` здесь не годится — он делает ровно обратное, добавляя столбцы и
    // оставляя плитку у нижней границы. Отбивка 32 — ритм сетки каталога.
    <ul className="grid gap-8 md:grid-cols-2 2xl:grid-cols-3">
      {items.map((t) => (
        <li key={t.id} className="relative">
          <Card className="gap-0 overflow-hidden p-0 transition-shadow hover:shadow-md">
            <TemplateThumb schema={t.schema} />
            <div className="border-t p-4">
              <h2 className="truncate text-base font-semibold">{t.title}</h2>
              <p className="mt-1 line-clamp-2 min-h-10 text-sm text-muted-foreground">
                {t.description}
              </p>
            </div>
          </Card>
          {/* НАЖИМАЕТСЯ ВСЯ ПЛИТКА, и делает это отдельная кнопка поверх неё, а не
              обёртка вокруг: внутри стоит лист формы с настоящими полями, а
              контролы в <button> вкладывать нельзя. Приём тот же, что у строки
              формы (FormRow) — растянутая на карточку невидимая кнопка с именем
              словами; миниатюра под ней inert, поэтому перехватить нажатие ей
              нечем. */}
          <button
            type="button"
            className="absolute inset-0 rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            onClick={() => onOpen(t)}
          >
            <span className="sr-only">Посмотреть шаблон «{t.title}»</span>
          </button>
          {/* Меню — ПОВЕРХ растянутой кнопки (z-10), иначе нажатие досталось бы
              ей: она накрывает карточку целиком. У витрины действий нет вовсе —
              публичный шаблон правится там же, где заводится. */}
          {t.visibility === 'private' && <TemplateActions template={t} />}
        </li>
      ))}
    </ul>
  )
}

// Действия шаблона — меню «⋯», а не иконка в углу: действие здесь одно и оно
// деструктивное, а такому в один клик не место (DESIGN-SYSTEM §7).
function TemplateActions({ template }: { template: FormTemplate }) {
  const remove = useDeleteTemplate()
  const [confirm, setConfirm] = useState(false)

  return (
    <>
      <div className="absolute top-2 right-2 z-10">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="bg-card/80 backdrop-blur-sm"
              aria-label={`Действия с шаблоном «${template.title}»`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
              <Trash2 className="size-4" />
              Удалить шаблон
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить шаблон «{template.title}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Формы, созданные из него, останутся на месте — шаблон копируется в форму, а не
              связывается с ней.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(template.id, {
                  onSuccess: () => toast.success(`Шаблон «${template.title}» удалён`),
                  onError: () => toast.error('Не удалось удалить шаблон'),
                })
              }
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
