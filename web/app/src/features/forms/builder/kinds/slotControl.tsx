import { Link } from '@tanstack/react-router'
import { CalendarClock, ChevronDown, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { SlotStub } from '@fields/slots/SlotStub'
import { humanError } from '../../../../shared/api/errors'
import { useFormFacts } from '../formFacts'
import { useScheduleChoice } from './scheduleChoice'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// SlotControl — вопрос о записи на полотне. Статичный и намеренно: реальное свободное
// время в кабинете не нужно и требовало бы публичной ручки, а править внутри строки
// нечего — строка записи ОБЪЕКТ (каретка встаёт на неё саму, кольцом), как дата и шкала.
//
// Показывается при этом ВЕСЬ вид пикера — лента дат и сетка времён (SlotStub из
// @fields): полотно остаётся WYSIWYG не по совпадению разметки, а по общему коду и общим
// стилям. Даты в заглушке настоящие, времена — образец: расписание здесь не называется,
// оно свойство ФОРМЫ и живёт в попапе строки.
//
// РАСПИСАНИЕ НЕ ВЫБРАНО — единственное состояние, в котором полотно показывает не то, что
// увидит респондент (решение владельца 2026-09-11): заглушка гаснет в серое и размывается,
// поверх неё плашка с быстрым выбором. Это не свойство вопроса, а недособранность формы — такая же,
// как пустая зона загрузки у картинки, — и выбор здесь только короткий путь: настройка
// по-прежнему живёт в попапе (SlotSettings), клавиатурный путь — через него.
//
// РЕЙЛ — граница объекта, виден при наведении на строку и когда на ней каретка (`group`
// строки, BlockRow — тот же, что зажигает кластер значков). Пикер состоит из четырёх
// частей (подпись месяца, лента, подпись дня, сетка), и без рейла на полотне читается
// четырьмя строками. Стоит в поле полотна, а не в форме: absolute, на вылете и в цвете
// рейла логики (`--border`, 3px) — вид формы не меняется ни на пиксель, в превью и у
// респондента рейла нет. Вылет
// тот же, что у рейла вопроса (`-left-2`, GroupRow): у вопроса из трёх и более блоков
// линии совпадают на отрезке записи, а не встают рядом — двух линий на разном вылете в
// жёлобе быть не должно. ⚠ На время любого жеста рейл гаснет (`data-dragging` на холсте
// полотна, SlashEditor) — и в строке, и в госте источника: в жёлобе во время драга не
// рисует никто, место называет линия вставки.
//
// ⚠ БЕЗ FieldWrap, и это не упущение: у обёртки потолок --rf-input-max (320px), и запись
// вставала бы на полотне в половину колонки, а у респондента — во всю. Её не надевают и
// остальные высокие объекты (файл, шкала, картинка, условие); цена — глифа типа в правом
// углу у записи нет, как и у них.
export function SlotControl() {
  const facts = useFormFacts()
  // Вне полотна фактов нет (тесты отдельных строк) — состояние неизвестно, плашки нет.
  const missing = facts !== null && facts.scheduleId === null

  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="bg-border pointer-events-none absolute top-0 bottom-0 -left-2 w-[3px] rounded-full opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 group-data-[dragging]/canvas:hidden"
      />
      {/* Серое, а не просто бледное: grayscale снимает зелень выбранного дня — иначе
          блок читался бы «настроенным, но тусклым». Размытие уводит заглушку в фон, и
          плашка поверх читается единственным, что здесь сейчас можно сделать. */}
      <div
        className={`transition-[opacity,filter] duration-300 ${missing ? 'opacity-50 blur-[3px] grayscale' : ''}`}
      >
        <SlotStub />
      </div>
      {missing && <MissingSchedule />}
    </div>
  )
}

// MissingSchedule — плашка «расписание не выбрано» по центру заглушки. Absolute: раскладку
// полотна она не трогает, замер ленты (useCols) идёт по той же ширине.
//
// @container — ширина КОЛОНКИ, а не окна: запись стоит и во всю форму, и в половине ряда.
// В узкой колонке пояснение уходит, остаются значок, заголовок и кнопка.
function MissingSchedule() {
  const { facts, schedules, choose } = useScheduleChoice()
  if (!facts) return null

  const list = schedules.data ?? []
  const none = schedules.isSuccess && list.length === 0
  const pick = (id: string) =>
    choose(id).catch((err: unknown) =>
      toast.error(humanError(err, 'Не удалось выбрать расписание')),
    )
  // ⚠ ССЫЛКА ВЕДЁТ В ПРОСТРАНСТВО ФОРМЫ — та же мина, что в попапе (SlotSettings).
  const toSchedules = { to: '/w/$workspaceSlug/schedules', params: { workspaceSlug: facts.workspaceSlug } } as const

  return (
    <div className="@container absolute inset-0 flex items-center justify-center p-3">
      <div className="flex max-w-full flex-wrap items-center justify-center gap-3 rounded-xl border bg-popover py-2.5 pr-2.5 pl-3 text-popover-foreground shadow-lg">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <CalendarClock className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">Расписание не выбрано</p>
          <p className="hidden text-sm text-muted-foreground @md:block">
            Свободное время форма возьмёт из него
          </p>
        </div>
        {none ? (
          <Button size="sm" asChild>
            <Link {...toSchedules}>
              <Plus /> Завести расписание
            </Link>
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                Выбрать <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Расписания пространства
              </DropdownMenuLabel>
              {schedules.isPending && <DropdownMenuItem disabled>Загружаем…</DropdownMenuItem>}
              {schedules.isError && (
                <DropdownMenuItem disabled>
                  {humanError(schedules.error, 'Не удалось загрузить расписания')}
                </DropdownMenuItem>
              )}
              {list.map((s) => (
                <DropdownMenuItem key={s.id} onSelect={() => void pick(s.id)}>
                  <CalendarClock /> {s.name}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link {...toSchedules}>
                  <Plus /> Завести расписание
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}
