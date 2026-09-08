import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

import { pluralQuestions } from '../../../shared/format'
import { TemplateSheet } from './TemplateSheet'
import { type FormTemplate, questionCaptions } from './templates'

// Крупный просмотр шаблона: форма целиком, из которой заводят свою.
//
// Окно, а не отдельная страница: смотрят шаблон, чтобы вернуться к выбору, и адрес
// у этого состояния не нужен. Полноэкранного режима (как у просмотра своей формы)
// тоже нет — там автор оценивает СВОЮ работу глазами респондента, здесь выбирает из
// шести заготовок и обязан помнить, что стоит за окном.
//
// Лист внутри — тот же компонент, что в плитке, только без масштаба: обещание
// «увидишь то же самое» держится одним кодом, а не сверкой двух вёрсток.
export function TemplateDialog({
  template,
  onOpenChange,
  onUse,
  pending,
  failed,
}: {
  // null = окно закрыто. Шаблон и открытость — одно состояние: окно без шаблона
  // нарисовать нечем, и держать их двумя переменными значит уметь их рассинхронить.
  template: FormTemplate | null
  onOpenChange: (open: boolean) => void
  onUse: (template: FormTemplate) => void
  pending: boolean
  failed: boolean
}) {
  return (
    <Dialog open={template !== null} onOpenChange={onOpenChange}>
      {template && (
        <DialogContent className="flex max-h-[90vh] w-[min(1100px,92vw)] flex-col gap-0 p-0 sm:max-w-none">
          <DialogHeader className="px-6 pt-6 pb-4">
            <DialogTitle>{template.title}</DialogTitle>
            <DialogDescription>{template.description}</DialogDescription>
          </DialogHeader>
          {/* ОКНО 16:9 — ТОТ ЖЕ ЭКРАН, ЧТО В ПЛИТКЕ, только в натуральную величину
              (решение владельца 2026-09-08). Плитка показывает его верх, окно — его
              целиком: форма прокручивается ВНУТРИ кадра, как на настоящей странице.
              Кадр не растёт под шаблон: у шаблонов разная длина, и окно ростом с
              самый длинный выглядело бы разным продуктом на каждой плитке.

              `aspect-video` задаёт высоту от ширины, но на невысоком мониторе она
              упёрлась бы в потолок окна — поэтому кадру разрешено сжиматься
              (`min-h-0` в колонке flex). Границы сверху и снизу отделяют белый холст
              формы от кабинета: без них лист сливается с окном в светлой теме. */}
          <div className="aspect-video min-h-0 overflow-y-auto border-y">
            <TemplateSheet template={template} />
          </div>
          <DialogFooter className="items-center px-6 py-4 sm:justify-between">
            {/* Слева — что именно получит автор, справа действие. Отказ занимает
                место подписи: он про то же нажатие и читается на его месте. */}
            {failed ? (
              <p role="alert" className="text-sm text-destructive">
                Не удалось создать форму. Попробуйте ещё раз.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {questionCaptions(template).length}{' '}
                {pluralQuestions(questionCaptions(template).length)}
              </p>
            )}
            <Button onClick={() => onUse(template)} disabled={pending}>
              {pending ? 'Создаём…' : 'Использовать шаблон'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
