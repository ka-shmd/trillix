import { useEffect, useRef, useState } from 'react'
import { Send, Sparkles, Trash2 } from 'lucide-react'

import { ApiError } from '../../../shared/api/errors'
import { PlanUpsell } from '../../plan/PlanUpsell'
import { usePlanQuota } from '../../plan/useFeature'
import { useBuilderStore, useBuilderStoreApi } from '../builder/storeContext'
import { MAX_CHAT_MESSAGE_LEN, sendChatMessage, type ChatTurn } from './api'
import { clearHistory, loadHistory, saveHistory } from './history'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'

// Шторка разговора с ассистентом (фаза 26, слайс E). Соседка шторки оформления и
// устроена так же — Sheet справа, — но живёт своим состоянием: разговор про форму
// продолжается между открытиями.
//
// ЛЕНТА СООБЩЕНИЙ С НАПОЛНЯЕМЫМ ПУЗЫРЁМ — это не украшение, а условие, при котором
// стриминг ответа (он отложен, `DEV-PLAN` фаза 26) добавится потом дёшево: менять
// придётся только источник текста внутри пузыря, а не устройство экрана.

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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b p-4">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="size-4" aria-hidden="true" />
            Ассистент
          </SheetTitle>
          <SheetDescription>
            Соберёт форму по описанию, поправит вопросы и расскажет, что в ней сейчас есть.
          </SheetDescription>
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

          {turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'flex flex-col items-end' : 'space-y-1'}>
              <div
                className={
                  t.role === 'user'
                    ? 'w-fit max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground'
                    : 'w-fit max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm'
                }
              >
                {t.text}
              </div>
              {t.plan && <PlanButton onClick={() => setUpsell(true)} />}
            </div>
          ))}

          {/* Пузырь ответа: сейчас в нём многоточие, со стримингом — текст по мере
              прихода. Место под него занято с первого дня намеренно. */}
          {pending && (
            <div className="w-fit rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
              Думаю…
            </div>
          )}

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
            disabled={pending}
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
