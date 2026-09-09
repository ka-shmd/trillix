import { useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

import { isAnswerableType } from '@entities/formSchema'

import { type FormTemplate } from '../../../entities/template'
import { pluralQuestions } from '../../../shared/format'
import { templateScreens } from './templateScreens'
import { TemplateSheet } from './TemplateSheet'

// Крупный просмотр шаблона: форма целиком, из которой заводят свою.
//
// Окно, а не отдельная страница: смотрят шаблон, чтобы вернуться к выбору, и адрес
// у этого состояния не нужен. Полноэкранного режима (как у просмотра своей формы)
// тоже нет — там автор оценивает СВОЮ работу глазами респондента, здесь выбирает из
// шести заготовок и обязан помнить, что стоит за окном.
//
// Лист внутри — тот же компонент, что в плитке, только без масштаба: обещание
// «увидишь то же самое» держится одним кодом, а не сверкой двух вёрсток.
//
// Вопросы считаются по документу (отвечаемые блоки), а не по описанию шаблона:
// описание пишет автор словами, и расходиться ему с содержимым нельзя.
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
          {/* Ход по страницам живёт в отдельном компоненте не ради опрятности: его
              состояние обязано умирать вместе с окном. Здесь, в `TemplateDialog`,
              хуки переживают закрытие (сам компонент смонтирован всегда, гаснет
              только содержимое), и следующий шаблон открывался бы на той странице, на
              которой автор бросил предыдущий. `key` добивает тот же случай для смены
              шаблона без закрытия. */}
          <TemplateWalk
            key={template.id}
            template={template}
            onUse={onUse}
            pending={pending}
            failed={failed}
          />
        </DialogContent>
      )}
    </Dialog>
  )
}

// ХОД ПО СТРАНИЦАМ ШАБЛОНА — часть ОКНА, а не листа (решение владельца 2026-09-09).
// Кнопки «Далее» и «Отправить» принадлежат форме и рисуются внутри листа; «Назад» и
// номер страницы форме не принадлежат — у респондента их нет, — поэтому стоят в
// подвале окна, рядом с числом вопросов и «Использовать шаблон».
//
// Отсюда и владение состоянием: номер страницы нужен и листу (что рисовать), и
// подвалу (что написать), то есть их общему предку. Лист остаётся рисователем одного
// экрана и своей памяти не имеет.
function TemplateWalk({
  template,
  onUse,
  pending,
  failed,
}: {
  template: FormTemplate
  onUse: (template: FormTemplate) => void
  pending: boolean
  failed: boolean
}) {
  // Состояние ПРОСМОТРА, не документа (web/CLAUDE.md): перезагрузку не переживает,
  // за пределы окна не нужно.
  const [page, setPage] = useState(0)
  const [done, setDone] = useState(false)
  // Разбор на экраны — тот же, которым лист рисует: «Страница 2 из 3» и нарисованное
  // обязаны считаться одними правилами (`templateScreens`).
  const { pages } = templateScreens(template.schema)
  const lastPage = pages.length - 1
  // Кадр — владелец прокрутки, поэтому сброс на шаге его. Без сброса вторая страница
  // открывалась бы с той высоты, на которой автор дочитал первую, то есть с середины.
  const frame = useRef<HTMLDivElement>(null)
  const step = (go: () => void) => {
    go()
    frame.current?.scrollTo({ top: 0 })
  }

  return (
    <>
      {/* ОКНО 16:9 — ТОТ ЖЕ ЭКРАН, ЧТО В ПЛИТКЕ, только в натуральную величину
          (решение владельца 2026-09-08). Плитка показывает его верх, окно — его
          целиком: форма прокручивается ВНУТРИ кадра, как на настоящей странице.
          Кадр не растёт под шаблон: у шаблонов разная длина, и окно ростом с
          самый длинный выглядело бы разным продуктом на каждой плитке.

          `aspect-video` задаёт высоту от ширины, но на невысоком мониторе она
          упёрлась бы в потолок окна — поэтому кадру разрешено сжиматься
          (`min-h-0` в колонке flex). Границы сверху и снизу отделяют белый холст
          формы от кабинета: без них лист сливается с окном в светлой теме. */}
      <div ref={frame} className="aspect-video min-h-0 overflow-y-auto border-y">
        <TemplateSheet
          schema={template.schema}
          page={page}
          done={done}
          onNext={() => step(() => setPage(page + 1))}
          onSubmit={() => step(() => setDone(true))}
        />
      </div>
      <DialogFooter className="items-center px-6 py-4 sm:justify-between">
        {/* Слева — что именно получит автор и где он сейчас, справа действие. Отказ
            занимает место подписи: он про то же нажатие и читается на его месте. */}
        <div className="flex items-center gap-3">
          {failed ? (
            <p role="alert" className="text-sm text-destructive">
              Не удалось создать форму. Попробуйте ещё раз.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {questionCount(template)} {pluralQuestions(questionCount(template))}
            </p>
          )}
          {/* Номера страницы у одностраничного шаблона нет: «Страница 1 из 1» —
              строка, которая ничего не сообщает. На экране после отправки его тоже
              нет — это не страница формы. */}
          {!done && pages.length > 1 && (
            <p className="text-sm text-muted-foreground">
              Страница {Math.min(page, lastPage) + 1} из {pages.length}
            </p>
          )}
          {(page > 0 || done) && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={() => step(() => (done ? setDone(false) : setPage(page - 1)))}
            >
              <ArrowLeft className="size-4" /> Назад
            </Button>
          )}
        </div>
        <Button onClick={() => onUse(template)} disabled={pending}>
          {pending ? 'Создаём…' : 'Использовать шаблон'}
        </Button>
      </DialogFooter>
    </>
  )
}

// questionCount — сколько вопросов в шаблоне: отвечаемых блоков документа. Тем же
// предикатом, каким их считает всё остальное (@entities/blocks/contract), а не
// перечислением типов на месте.
function questionCount(template: FormTemplate): number {
  return template.schema.blocks.filter((b) => isAnswerableType(b.type)).length
}
