import { useState } from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'

import type { MetrikaCounter } from '../../entities/integration'
import { useSetMetrika } from './queries'
import { MetrikaIcon } from './ServiceIcon'
import { humanError } from '../../shared/api/errors'
import { RAISED_INPUT } from '../../shared/raisedField'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Окно Яндекс Метрики — тот же полноэкранный оверлей, что у вебхука и Таблиц
// (фаза 29, design/yandex-metrika.md §8): номер счётчика, цели для заведения в
// Метрике и условия, при которых они отмечаются.
//
// Условия работы стоят на экране, а не в справке, — решение владельца 2026-09-15:
// до вики автору негде узнать, что встроенная форма без счётчика на сайте целей не
// отмечает. С появлением вики текст уезжает туда.

// Имена целей — контракт со счётчиком автора и зеркало GOAL_* в
// web/renderer/src/features/form/metrika.ts: разойдутся — цели, заведённые по этому
// экрану, не засчитаются никогда, и молча.
const GOALS = [
  { id: 'trillix_open', text: 'Форму открыли' },
  { id: 'trillix_start', text: 'Начали заполнять' },
  { id: 'trillix_submit', text: 'Отправили ответ' },
] as const

export function MetrikaOverlay({
  formId,
  metrika,
  onClose,
}: {
  formId: string
  // metrika — правим подключённый счётчик; null — подключаем.
  metrika: MetrikaCounter | null
  onClose: () => void
}) {
  const [counter, setCounter] = useState(metrika?.counter ?? '')
  const save = useSetMetrika(formId)

  async function submit() {
    try {
      // Тумблер окно не трогает: правка номера у выключенного счётчика его не включает.
      await save.mutateAsync({ counter: counter.trim(), enabled: metrika?.enabled ?? true })
      onClose()
    } catch {
      // Отказ показан ниже из состояния мутации: окно остаётся открытым, чтобы
      // человек поправил номер, а не вписывал его заново.
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-svh max-h-svh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none border-none p-0 sm:max-w-none"
        style={{ top: 0, left: 0 }}
      >
        <div className="mx-auto my-auto flex w-full max-w-xl flex-col gap-8 px-6 py-16">
          <header className="flex flex-col items-center gap-3 text-center">
            <MetrikaIcon className="size-10" />
            <DialogTitle className="text-3xl">Яндекс Метрика</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Цели формы отмечаются в вашем счётчике: открыли, начали заполнять, отправили.
            </p>
          </header>

          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Label htmlFor="metrika-counter">Номер счётчика</Label>
              <Input
                id="metrika-counter"
                inputMode="numeric"
                autoFocus
                placeholder="12345678"
                className={RAISED_INPUT}
                value={counter}
                onChange={(e) => setCounter(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm font-semibold">Цели</p>
              <ul className="flex flex-col">
                {GOALS.map((goal) => (
                  <li key={goal.id} className="flex items-center gap-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium">{goal.id}</p>
                      <p className="text-sm text-muted-foreground">{goal.text}</p>
                    </div>
                    <CopyGoal id={goal.id} />
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">
                В Метрике: «Цели» → «Добавить цель» → «JavaScript-событие», идентификатор — из
                списка выше.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm font-semibold">Где отмечаются цели</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                <li>На странице формы — всегда.</li>
                <li>
                  В форме, встроенной на сайт, — если на этом сайте установлен тот же счётчик и
                  форма вставлена кодом с экрана «Встроить».
                </li>
                <li>Во вставке без загрузчика или ссылкой (Notion и подобные) цели не отмечаются.</li>
              </ul>
              <p className="text-sm text-muted-foreground">
                Вебвизор на форме не работает: то, что человек вводит в поля, не записывается.
              </p>
            </div>

            {save.error != null && (
              <p role="alert" className="flex gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {humanError(save.error)}
              </p>
            )}

            {/* Одно действие во всю ширину, как в окнах вебхука и Таблиц. */}
            <Button size="lg" disabled={save.isPending || counter.trim() === ''} onClick={submit}>
              {save.isPending ? 'Сохраняем…' : metrika ? 'Сохранить' : 'Подключить'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// CopyGoal — скопировать идентификатор цели. Чёрная служебная кнопка — облик
// «копировать» у поля (DESIGN-SYSTEM); подпись одна на доступное имя и подсказку,
// как у значков строки. Ответ на нажатие — галочка на полторы секунды, тот же, что у
// «Копировать» на экране «Встроить».
function CopyGoal({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const label = `Скопировать ${id}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="utility"
          size="icon-sm"
          aria-label={label}
          onClick={() => {
            navigator.clipboard
              .writeText(id)
              .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
              .catch(() => {
                // Буфер недоступен — идентификатор виден рядом, его можно выделить.
              })
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
