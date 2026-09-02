import { useEffect, useRef, useState } from 'react'
import { Send, Trash2 } from 'lucide-react'

import { useAppDrawerOffset } from '../../../shared/appDrawer'
import { ApiError } from '../../../shared/api/errors'
import { PlanUpsell } from '../../plan/PlanUpsell'
import { usePlanQuota } from '../../plan/useFeature'
import { chords } from '../builder/shortcuts'
import { useBuilderStore, useBuilderStoreApi } from '../builder/storeContext'
import { MAX_CHAT_MESSAGE_LEN, sendChatMessage, type ChatTurn } from './api'
import { clearHistory, loadHistory, saveHistory } from './history'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'

// Шторка разговора с ассистентом (фаза 26, слайс E). Соседка шторки оформления и
// устроена ТАК ЖЕ (решение владельца 2026-09-02): не накрывает страницу, а отодвигает
// её — без затемнения, с сдвигом шапки и полотна. Довод тот же, что у оформления:
// автор смотрит НЕ в панель, а на форму рядом. Правка от ассистента ложится на полотно
// сразу, и увидеть её он обязан не выходя из разговора.
//
// Отсюда три отступления от вендоренного Sheet — те же, что у DesignDrawer:
// modal={false} (фокус не заперт, полотно кликабельно), showOverlay={false}
// (затемнение убило бы ровно тот смысл, ради которого шторка выбрана) и запрет
// закрытия по клику снаружи (правка формы при открытом чате не должна его захлопывать).
//
// Своё состояние у неё остаётся: разговор про форму продолжается между открытиями.
//
// ВИДА ЧАТА У ЛЕНТЫ НЕТ (решение владельца 2026-09-02): реплика автора — рамка, ответ
// ассистента — просто текст, обе во всю ширину. Пузыри с заливкой, прижатые к разным
// краям, делают из панели мессенджер, а здесь идёт работа над документом: ответ читают
// как текст, а не как сообщение собеседника.
//
// Место ответа при этом занято отдельной строкой намеренно — стриминг (он отложен,
// `DEV-PLAN` фаза 26) заменит в ней источник текста, а не устройство ленты.

const EXAMPLES = [
  'Собери анкету записи в барбершоп: имя, телефон, мастер, дата',
  'Добавь вопрос, откуда узнали о нас',
  'Что тут спрашивается?',
]

// Отказы разбираются по КОДУ конверта, а не по тексту: текст меняется, код — контракт.
function failureText(error: unknown): { text: string; plan: boolean } {
  if (!(error instanceof ApiError)) {
    return { text: 'Не получилось. Попробуйте ещё раз.', plan: false }
  }
  switch (error.code) {
    // Отказ по тарифу бывает ДВУХ РОДОВ: кончились сообщения и упёрлись в платную
    // настройку вида. Код у них один, поэтому причину называет сервер, а не мы:
    // своя фраза про исчерпанные сообщения врала автору, у которого их тридцать из
    // тридцати, а отказ был про цвета.
    case 'plan_required':
      return { text: error.message, plan: true }
    case 'not_found':
      return { text: 'Ассистент здесь не настроен — форму можно собрать и поправить руками.', plan: false }
    case 'rate_limited':
      return { text: 'Слишком часто. Подождите немного и повторите.', plan: false }
    case 'unavailable':
    case 'validation_failed':
      return { text: error.message, plan: false }
    default:
      return { text: 'Не получилось. Попробуйте ещё раз.', plan: false }
  }
}

export function ChatDrawer({
  open,
  onOpenChange,
  formId,
  ensureFormId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  // formId — id формы; пусто, пока форма ещё не создана (ленивое создание).
  formId: string
  // ensureFormId заводит форму, если её ещё нет: разговор — такая же первая правка,
  // как набор текста на полотне, и требовать «сначала сохраните» незачем.
  ensureFormId: () => Promise<string>
}) {
  const storeApi = useBuilderStoreApi()
  const applyExternal = useBuilderStore((s) => s.applyExternal)
  // Остаток сообщений — серверный стейт (снимок тарифа), а не счётчик в шторке:
  // квота живёт на пространстве, и вторая вкладка расходует ту же тридцатку.
  const quota = usePlanQuota('ai_generations')
  // Оболочка съезжает под шторку — тем же хуком и на ту же ширину, что у оформления.
  useAppDrawerOffset(open)

  // Разговор поднимается из хранилища ОДИН раз, на монтировании: экран редактора
  // пересоздаётся при смене формы (ключ маршрута), поэтому подписываться на formId
  // здесь не на что — а setState в эффекте дал бы каскад перерисовок на ровном месте.
  // Форма, созданная по ходу разговора, получает свою историю при первой же отправке.
  const [turns, setTurns] = useState<ChatTurn[]>(() => (formId ? loadHistory(formId) : []))
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // Разговор о тарифе — тем же оверлеем, что и у прочих платных возможностей
  // (`features/plan/PlanUpsell`): чат не заводит своего разговора о деньгах.
  const [upsell, setUpsell] = useState(false)
  const feed = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  // Лента прокручивается к свежему — и когда пришёл ответ, и когда ушёл вопрос.
  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight })
  }, [turns.length, pending])

  const trimmed = draft.trim()

  async function send(text: string) {
    if (text === '' || pending) return
    setPending(true)
    setError(null)
    const asked: ChatTurn[] = [...turns, { role: 'user', text }]
    setTurns(asked)
    setDraft('')
    // КАРЕТКА ОСТАЁТСЯ В ПОЛЕ: отправляют и мышью по кнопке, и подсказкой-примером,
    // а обе забирают фокус себе — следующую реплику пришлось бы начинать с клика по
    // полю. Разговор ведут с клавиатуры, и поле ввода — его место по умолчанию.
    input.current?.focus()

    try {
      const id = formId || (await ensureFormId())
      const res = await sendChatMessage(id, text, turns, storeApi.getState().toSchema())
      // Документ ложится на полотно ОДНИМ шагом истории: подтверждать правку
      // кнопкой посреди разговора незачем, откат (Ctrl+Z) и есть подтверждение.
      if (res.schema) applyExternal(res.schema)
      const answered: ChatTurn[] = [
        ...asked,
        { role: 'assistant', text: res.reply, plan: res.planRequired },
      ]
      setTurns(answered)
      saveHistory(id, answered)
      // Списание произошло на сервере — снимок тарифа устарел ровно сейчас.
      quota?.refresh()
    } catch (err) {
      // Реплика автора остаётся в ленте: она уже сказана, и стирать её вместе с
      // отказом значило бы заставить набирать заново.
      setError(err)
    } finally {
      setPending(false)
    }
  }

  function reset() {
    setTurns([])
    setError(null)
    if (formId) clearHistory(formId)
  }

  const failure = error === null ? null : failureText(error)

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        showOverlay={false}
        // Фокус уводится В ПОЛЕ ВВОДА, а не запрещается вовсе (в отличие от
        // оформления): шторку открывают, чтобы сказать, а не чтобы смотреть.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          input.current?.focus()
        }}
        // Клик по полотну — обычный клик по полотну, а не «закрыть чат»: иначе любая
        // правка формы посреди разговора захлопывала бы его.
        onInteractOutside={(e) => e.preventDefault()}
        // Alt+J ЗАКРЫВАЕТ ШТОРКУ ИЗНУТРИ. Оконный слушатель экрана (useGlobalChord)
        // сюда не дотягивается намеренно: он молчит в полях всплывающих слоёв, чтобы
        // не съедать ввод, — а фокус здесь как раз в поле. Тогл поэтому дублируется
        // на самой шторке; событие из поля всплывает по дереву React и приходит сюда.
        onKeyDown={(e) => {
          if (!chords.openChat(e)) return
          e.preventDefault()
          onOpenChange(false)
        }}
        // Длительность выровнена с оболочкой (300 мс в обе стороны против штатных
        // 500/300): панель и шапка обязаны ехать одним движением, иначе видно, что
        // это два разных элемента.
        className="flex w-104 flex-col gap-0 p-0 sm:max-w-104 data-[state=closed]:duration-300 data-[state=open]:duration-300"
        // Подзаголовка у шторки нет (решение владельца 2026-09-02), поэтому Radix
        // нужно сказать об этом явно — иначе он пишет в консоль предупреждение об
        // отсутствующем Description (тот же гард, что у шторки оформления).
        aria-describedby={undefined}
      >
        <SheetHeader className="border-b p-4">
          <SheetTitle>Помощь ИИ</SheetTitle>
          {quota !== undefined && quota.limit !== null && (
            <QuotaLine used={quota.used} limit={quota.limit} onPlan={() => setUpsell(true)} />
          )}
        </SheetHeader>

        <div ref={feed} className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
          {turns.length === 0 && !pending && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">С чего начнём:</p>
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => void send(e)}
                  className="block w-full rounded-lg border px-3 py-2 text-left text-sm hover:bg-muted"
                >
                  {e}
                </button>
              ))}
            </div>
          )}

          {/* ЛЕНТА БЕЗ ВИДА ЧАТА (решение владельца 2026-09-02): реплика автора — рамка,
              ответ — просто текст, обе во всю ширину. Пузыри с заливкой и прижатые к
              краям делают из панели мессенджер; здесь же идёт работа над документом, и
              ответ ассистента читается как текст, а не как сообщение собеседника.
              Рамка у своей реплики нужна, чтобы взгляд находил, с чего начался ответ. */}
          {turns.map((t, i) => (
            <div key={i} className="space-y-1">
              {t.role === 'user' ? (
                <p className="rounded-lg border px-3 py-2 text-sm">{t.text}</p>
              ) : (
                <p className="text-sm whitespace-pre-line">{t.text}</p>
              )}
              {t.plan && <PlanButton onClick={() => setUpsell(true)} />}
            </div>
          ))}

          {/* Место ответа занято с первого дня намеренно: со стримингом (он отложен,
              `DEV-PLAN` фаза 26) здесь появится текст по мере прихода, и менять
              придётся источник строки, а не устройство ленты. */}
          {pending && <p className="text-sm text-muted-foreground">Думаю…</p>}

          {failure && (
            <div className="space-y-1">
              <p role="alert" className="text-sm text-destructive">
                {failure.text}
              </p>
              {failure.plan && <PlanButton onClick={() => setUpsell(true)} />}
            </div>
          )}
        </div>

        <form
          className="border-t p-4"
          onSubmit={(e) => {
            e.preventDefault()
            void send(trimmed)
          }}
        >
          <Textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter отправляет, Shift+Enter переносит строку — как в любом чате.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(trimmed)
              }
            }}
            placeholder="Опишите форму или скажите, что поправить"
            maxLength={MAX_CHAT_MESSAGE_LEN}
            rows={3}
            // ПОЛЕ НЕ ГАСИТСЯ НА ВРЕМЯ ОТВЕТА: disabled снимает фокус с элемента, и
            // каретка уходила из поля на каждой отправке. Набирать следующую реплику,
            // пока едет ответ, можно — отправку держит кнопка (она и объясняет
            // ожидание словом «Отправляю…») и проверка pending в send.
            aria-label="Сообщение ассистенту"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={reset}
              disabled={pending || turns.length === 0}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Очистить
            </Button>
            <Button type="submit" size="sm" disabled={trimmed === '' || pending}>
              <Send className="size-4" aria-hidden="true" />
              {pending ? 'Отправляю…' : 'Отправить'}
            </Button>
          </div>
        </form>
      </SheetContent>
      <PlanUpsell open={upsell} onOpenChange={setUpsell} />
    </Sheet>
  )
}

// Остаток сообщений в шапке: автор видит цену разговора ДО того, как упрётся в
// отказ. Считается вычитанием (расход из лимита), потому что снимок тарифа отдаёт
// израсходованное, а человека занимает оставшееся.
//
// Кончившиеся сообщения зовут к тарифу тем же оверлеем, что и остальное платное:
// это единственное состояние индикатора, в котором автору есть что сделать.
function QuotaLine({ used, limit, onPlan }: { used: number; limit: number; onPlan: () => void }) {
  // Расход может обогнать лимит (тариф понизили с уже потраченным) — ниже нуля не
  // показываем: «осталось −7» это отчёт о нашей бухгалтерии, а не ответ автору.
  const left = Math.max(limit - used, 0)
  if (left === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Сообщения на этом тарифе кончились.{' '}
        <button type="button" onClick={onPlan} className="underline underline-offset-2">
          Посмотреть тарифы
        </button>
      </p>
    )
  }
  return (
    <p className="text-xs text-muted-foreground">
      Осталось {left} из {limit} сообщений в этом месяце
    </p>
  )
}

// Предложение тарифа под репликой: КНОПКА, открывающая общий оверлей, а не ссылка на
// страницу тарифов. Ссылка уводила бы автора из разговора и из редактора, а оверлей
// рассказывает про тариф на месте и закрывается обратно в чат.
function PlanButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      Посмотреть тарифы
    </Button>
  )
}
