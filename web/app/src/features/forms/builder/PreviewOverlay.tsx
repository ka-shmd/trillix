import { useEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { StoreApi } from 'zustand'

import { Button } from '@/components/ui/button'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet'

import { PreviewFrame } from './PreviewFrame'
import { PreviewPane } from './PreviewPane'
import type { BuilderStore } from './store'

// ПРОСМОТР — ОТДЕЛЬНАЯ СТРАНИЦА ПОВЕРХ КАБИНЕТА, а не область внутри него (решение
// владельца 2026-08-15). Слой закрывает окно целиком: ни шапки, ни сайдбара вокруг
// формы — иначе автор оценивает её в чужой рамке шириной с рабочую область, то есть
// смотрит не на то, что увидит респондент. Ширина колонки формы и центровка тут
// настоящие, вьюпортные.
//
// Слой — вендоренный `Sheet` (Radix Dialog) стороной `full`, а не свой
// `position: fixed`: он даёт ловушку фокуса, замок скролла страницы под собой и Esc —
// всё то, что руками пишется с ошибками. Сторона `full` (добавка к компоненту, см.
// sheet.tsx) значит «во весь вьюпорт и без выезда»: просмотр не приезжает с края
// экрана, а появляется. Штатная крестовина снята — выход один и подписан словами.
//
// Полотно под просмотром ОСТАЁТСЯ смонтированным: возврат обязан вернуть автора туда
// же — с той же прокруткой и той же кареткой. Ценой этого полотно продолжает слушать
// оконные шорткаты, но ловушка фокуса Radix не пускает в него ни ввод, ни клики.

// ЖЁЛОБ ПОЛОСЫ ПРОКРУТКИ КАБИНЕТА НА ВРЕМЯ ПРОСМОТРА СНИМАЕТСЯ. `html` держит
// `scrollbar-gutter: stable` (index.css, там же зачем), и жёлоб этот браузер рисует ЗА
// пределами вьюпорта — накрыть его слоем физически нельзя. Рядом с полосой прокрутки
// самой формы он и встаёт второй полосой: у окна, отданного форме, их видно две.
//
// Атрибут ставится МОНТАЖОМ содержимого слоя, а не эффектом по `open`: снятый жёлоб
// раздвигает вьюпорт на свою ширину, и полотно под слоем сдвигается — сдвиг обязан
// случиться, пока полотна не видно. Radix монтирует содержимое ровно на время
// открытого слоя, поэтому граница совпадает сама.
function ScrollbarGutterOff() {
  useEffect(() => {
    document.documentElement.dataset.previewOpen = ''
    return () => {
      delete document.documentElement.dataset.previewOpen
    }
  }, [])
  return null
}

// ВОЗВРАТ ФОКУСА — НАШ, потому что радиксовый здесь не работает вовсе. Модальный
// диалог на закрытии отменяет умолчание браузера и ставит фокус на ТРИГГЕР
// (`triggerRef.current?.focus()` в react-dialog). Триггера у просмотра нет: слой
// открывает обычная кнопка верхнего бара через состояние, а не `SheetTrigger`, и
// ссылка пустая. Фокус тогда не достаётся никому и падает в `body` — автор
// возвращается на полотно, где нельзя ни печатать, ни уйти Tab'ом от своего места, а
// обещание слоя (вернуть туда же, с той же прокруткой и той же кареткой) выполняется
// наполовину.
//
// Каретка помнится ОТДЕЛЬНО от последнего фокуса вообще: кнопка «Просмотр» забирает
// фокус кликом раньше, чем слой открывается, поэтому «последний сфокусированный» —
// это она, а не строка полотна. Слушатель живёт только пока слой закрыт: внутри слоя
// фокус наш собственный, и запоминать его незачем.
function useReturnFocus(open: boolean) {
  const caret = useRef<HTMLElement | null>(null)
  const anyFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (open) return
    const onFocusIn = (e: Event) => {
      const el = e.target
      if (!(el instanceof HTMLElement)) return
      anyFocus.current = el
      const typable =
        el.isContentEditable ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLInputElement
      if (typable) caret.current = el
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [open])

  return (event: Event) => {
    // Строку могли снести, пока автор смотрел форму (правка из шторки оформления,
    // отмена) — тогда возвращаемся на то, что было в фокусе до слоя, а если и его
    // нет, отдаём событие Radix: пусть лучше решает он, чем мы фокусируем труп.
    const back = [caret.current, anyFocus.current].find((el) => el?.isConnected)
    if (!back) return
    event.preventDefault()
    // МИНА: preventScroll обязателен. Без него браузер подкрутит окно к возвращаемой
    // строке — и прокрутка, ради сохранения которой полотно всё это время и остаётся
    // смонтированным, уедет ровно в момент возврата.
    back.focus({ preventScroll: true })
  }
}

export function PreviewOverlay({
  open,
  onOpenChange,
  store,
  title,
  badge,
  progress = false,
  allowBack = false,
  consent = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  store: StoreApi<BuilderStore>
  title: string
  badge: boolean
  // Как и badge — живые свойства формы, а не документ (см. PreviewPane).
  progress?: boolean
  allowBack?: boolean
  consent?: boolean
}) {
  const returnFocus = useReturnFocus(open)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* aria-describedby={undefined} — у просмотра нет пояснения, а Radix иначе
          ругается на ссылку в пустоту. */}
      <SheetContent
        side="full"
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={returnFocus}
        className="gap-0 overflow-hidden p-0"
      >
        <SheetTitle className="sr-only">Просмотр формы</SheetTitle>
        <ScrollbarGutterOff />
        {/* Выход — ПЕРВЫМ в разметке, хотя нарисован поверх фрейма: Tab из
            содержимого обязан приводить к нему, а не гонять автора по форме. */}
        <SheetClose asChild>
          <Button
            variant="outline"
            size="sm"
            className="absolute top-4 left-4 z-10 gap-1.5 shadow-lg"
          >
            <ArrowLeft className="size-4" /> Назад к редактированию
          </Button>
        </SheetClose>
        {/* Esc приходит ДВУМЯ путями: из документа кабинета его ловит Radix, из
            документа фрейма — сам фрейм (событие через границу документов не
            всплывает, а курсор автора почти всегда внутри формы). */}
        <PreviewFrame store={store} onEscape={() => onOpenChange(false)}>
          <PreviewPane
            title={title}
            badge={badge}
            progress={progress}
            allowBack={allowBack}
            consent={consent}
          />
        </PreviewFrame>
      </SheetContent>
    </Sheet>
  )
}
