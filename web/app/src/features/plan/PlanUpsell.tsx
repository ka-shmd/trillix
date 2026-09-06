import { Link } from '@tanstack/react-router'

import { usePlanLink } from '../../shared/planLink'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

// РЕКЛАМНЫЙ ОВЕРЛЕЙ ТАРИФА — один на все попытки включить платное на бесплатном
// тарифе (решение владельца 2026-08-28). Содержимое ОБЩЕЕ: оверлей не называет ту
// настройку, из-за которой открылся, — он рассказывает про тариф целиком, и потому
// переиспользуется без параметров.
//
// Содержимое ниже — ЗАГЛУШКА до макета дизайнера: текст и раскладка заменятся
// целиком, контракт компонента (`open`/`onOpenChange`) переживёт замену.
//
// Сегодня оверлей не открывается ни у кого: гейты продукта реализованы, но открыты
// всем планам (BILLING §6) — `useFeatureAllowed` отвечает «можно». Закроют гейт
// одним UPDATE'ом, и оверлей заработает без выкатки фронта.
//
// Полноэкранный слой, а не окно (решение владельца 2026-08-28): под рекламный макет
// нужна вся площадь экрана. Собран из shadcn `Dialog` с перебивкой геометрии через
// `cn` — Radix оставляет за собой Escape, ловушку фокуса, возврат фокуса на триггер
// и блокировку прокрутки под слоем; своя обёртка эти четыре вещи потеряла бы.
export function PlanUpsell({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const planLink = usePlanLink()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Порядок классов несущий: перебивки идут ПОСЛЕ базовых, конфликт разрешает
          tailwind-merge внутри `cn` (web/CLAUDE.md — на одинаковой специфичности
          «класс сверху» сам по себе не побеждает). */}
      <DialogContent className="inset-0 max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-none border-0 sm:max-w-none">
        <div className="m-auto flex max-w-2xl flex-col items-center gap-4 text-center">
          <DialogTitle className="text-3xl font-extrabold tracking-tight">
            Это на платном тарифе
          </DialogTitle>
          <DialogDescription className="text-base">
            Платный тариф снимает лимит на ответы, отдаёт форму без подписи «Сделано в Trillix»,
            открывает своё оформление, сбор незавершённых ответов и полную аналитику.
          </DialogDescription>
          {/* Кнопки в обратном порядке на узком экране — как в футере окон кабинета:
              главное действие оказывается ближе к большому пальцу. */}
          <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row">
            <DialogClose asChild>
              <Button variant="ghost">Не сейчас</Button>
            </DialogClose>
            <Button asChild>
              <Link {...planLink}>Посмотреть тарифы</Link>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
