import { useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, Check, Copy, Eye, KeyRound, RefreshCw, Send } from 'lucide-react'

import type { Webhook, WebhookTest } from '../../entities/integration'
import { getWebhookSecret } from './api'
import {
  useCreateWebhook,
  useReissueWebhookSecret,
  useTestWebhook,
  useUpdateWebhook,
} from './queries'
import { WebhookIcon } from './ServiceIcon'
import { humanError } from '../../shared/api/errors'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Окно вебхука — полноэкранный оверлей, как у Google Таблиц: решения о том,
// куда уедут ответы, принимают до первой отправки наружу, и в строке списка они
// превратились бы в цепочку кнопок, каждая из которых уже что-то поменяла.
//
// Внутри — Radix Dialog, растянутый на вьюпорт: от него нужны ловушка фокуса,
// Escape и блокировка прокрутки под ним, а не вид карточки.

export function WebhookOverlay({
  formId,
  webhook,
  onClose,
}: {
  formId: string
  // webhook — правим существующий; null — заводим новый.
  webhook: Webhook | null
  onClose: () => void
}) {
  const [url, setUrl] = useState(webhook?.url ?? '')
  const [name, setName] = useState(webhook?.name ?? '')
  // ownSecret — секрет автора, введённый ПРИ ПОДКЛЮЧЕНИИ. Пусто — сгенерируем
  // сами: про секрет человек думает ровно в этот момент, потому что в тот же
  // заход настраивает проверку у получателя.
  const [ownSecret, setOwnSecret] = useState('')
  const create = useCreateWebhook(formId)
  const update = useUpdateWebhook(formId)
  // secret — секрет подписи в открытом виде. В состоянии таба его нет никогда:
  // он приезжает либо ответом на заведение, либо по нажатию «Показать».
  const [secret, setSecret] = useState<string | null>(null)
  // created — вебхук, заведённый прямо сейчас. Окно после заведения НЕ
  // закрывается и переходит в режим настройки: секрет и «Проверить» нужны
  // человеку в тот же заход, а не после повторного открытия строки списка.
  const [created, setCreated] = useState<Webhook | null>(null)
  const target = webhook ?? created
  const saving = create.isPending || update.isPending
  const error = create.error ?? update.error

  function save() {
    if (target) {
      // Адрес шлётся всегда, даже неизменённый: так правящий становится
      // ответственным за доставку и снимает поломку (спека §9).
      update.mutate({ id: target.id, name, url }, { onSuccess: onClose })
      return
    }
    create.mutate(
      { name, url, secret: ownSecret.trim() || undefined },
      {
        onSuccess: (fresh) => {
          // Свежий секрет показывается сразу: заставлять человека жать
          // «Показать» в только что открытом окне незачем.
          setSecret(fresh.secret)
          setCreated(fresh)
        },
      },
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-svh max-h-svh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none border-none p-0 sm:max-w-none"
        style={{ top: 0, left: 0 }}
      >
        <div className="mx-auto my-auto flex w-full max-w-xl flex-col gap-8 px-6 py-16">
          <header className="flex flex-col items-center gap-3 text-center">
            <WebhookIcon className="size-10" />
            <DialogTitle className="text-3xl">Вебхук</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Каждый новый ответ формы уйдёт запросом на ваш адрес — через секунды после
              отправки.
            </p>
          </header>

          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Label htmlFor="webhook-url">Адрес получателя</Label>
              <Input
                id="webhook-url"
                type="url"
                inputMode="url"
                autoFocus
                placeholder="https://hooks.zapier.com/hooks/catch/…"
                className="h-10 md:text-base"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Только https. Запросы во внутреннюю сеть и на адреса самого Trillix не
                отправляются.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="webhook-name">Название</Label>
              <Input
                id="webhook-name"
                placeholder="CRM"
                className="h-10 md:text-base"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Необязательно: по нему вебхук узнаётся в списке, когда их несколько.
              </p>
            </div>

            {/* До заведения секрет можно только ЗАДАТЬ: показывать, менять и
                проверять ещё нечего. После — полный набор, включая «Проверить».  */}
            {target ? (
              <>
                <SecretField
                  formId={formId}
                  webhookId={target.id}
                  secret={secret}
                  onSecret={setSecret}
                />
                <TestField formId={formId} webhookId={target.id} />
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <Label htmlFor="webhook-new-secret">Секрет подписи</Label>
                <Input
                  id="webhook-new-secret"
                  className="h-10 font-mono md:text-base"
                  placeholder="Сгенерируем сами"
                  value={ownSecret}
                  onChange={(e) => setOwnSecret(e.target.value)}
                />
                <p className="text-sm text-muted-foreground">
                  Необязательно. Свой секрет удобен, когда получатель один на несколько форм:
                  проверка у него настраивается один раз. От {MIN_SECRET} символов.
                </p>
              </div>
            )}

            <SignatureHint />

            {error && (
              <p role="alert" className="flex gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {humanError(error)}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {created ? 'Готово' : 'Отмена'}
              </Button>
              {/* После заведения кнопка становится «Сохранить»: она правит уже
                  заведённый вебхук, а не заводит второй. */}
              <Button
                disabled={
                  saving ||
                  url.trim() === '' ||
                  (!target && ownSecret.trim() !== '' && ownSecret.trim().length < MIN_SECRET)
                }
                onClick={save}
              >
                {saving ? 'Сохраняем…' : target ? 'Сохранить' : 'Подключить'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// SecretField — секрет подписи: показать по нажатию и перевыпустить.
//
// Запрашивается ручкой, а не приезжает в состоянии таба: это ключ, которым
// подписан каждый запрос, и раздавать его на каждый показ экрана незачем.
function SecretField({
  formId,
  webhookId,
  secret,
  onSecret,
}: {
  formId: string
  webhookId: string
  secret: string | null
  onSecret: (secret: string) => void
}) {
  const reissue = useReissueWebhookSecret(formId)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  // own — открыт ввод своего секрета. Ввод — отдельное состояние, а не правка
  // того же поля: показанный секрет читают и копируют, и случайная правка в нём
  // означала бы молча сломанную подпись у получателя.
  const [own, setOwn] = useState<string | null>(null)

  function show() {
    setLoading(true)
    setError(null)
    getWebhookSecret(formId, webhookId)
      .then(onSecret)
      .catch(setError)
      .finally(() => setLoading(false))
  }

  function save(value?: string) {
    reissue.mutate(
      { webhookId, secret: value },
      {
        onSuccess: (fresh) => {
          onSecret(fresh)
          setOwn(null)
        },
      },
    )
  }

  if (own !== null) {
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor="webhook-own-secret">Свой секрет подписи</Label>
        <div className="flex items-center gap-2">
          <Input
            id="webhook-own-secret"
            autoFocus
            className="h-10 font-mono md:text-base"
            value={own}
            onChange={(e) => setOwn(e.target.value)}
          />
          {/* Не просто «Сохранить»: внизу окна уже есть кнопка с этой надписью,
              и списком кнопок они неразличимы. */}
          <Button
            disabled={reissue.isPending || own.trim().length < MIN_SECRET}
            onClick={() => save(own.trim())}
          >
            Сохранить секрет
          </Button>
          <Button variant="ghost" onClick={() => setOwn(null)}>
            Отмена
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          От {MIN_SECRET} символов. Свой секрет удобен, когда получатель один на несколько форм:
          проверка у него настраивается один раз.
        </p>
        {reissue.error && (
          <p role="alert" className="text-sm text-destructive">
            {humanError(reissue.error)}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="webhook-secret">Секрет подписи</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="webhook-secret"
          readOnly
          className="h-10 min-w-48 flex-1 font-mono md:text-base"
          value={secret ?? '••••••••••••••••'}
          onFocus={(e) => e.currentTarget.select()}
        />
        {secret ? (
          <CopyButton value={secret} />
        ) : (
          <Button variant="outline" disabled={loading} onClick={show}>
            <Eye className="size-4" aria-hidden />
            Показать
          </Button>
        )}
        <Button variant="outline" disabled={reissue.isPending} onClick={() => save()}>
          <RefreshCw className="size-4" aria-hidden />
          Перевыпустить
        </Button>
        <Button variant="outline" onClick={() => setOwn('')}>
          <KeyRound className="size-4" aria-hidden />
          Задать свой
        </Button>
      </div>
      {/* Перевыпуск действует сразу — об этом сказано ДО нажатия: у получателя,
          который проверяет подпись, запросы начнут отбиваться в ту же секунду. */}
      <p className="text-sm text-muted-foreground">
        Новый секрет начинает действовать сразу — не забудьте поменять его у получателя.
      </p>
      {(error ?? reissue.error) && (
        <p role="alert" className="text-sm text-destructive">
          {humanError(error ?? reissue.error)}
        </p>
      )}
    </div>
  )
}

// MIN_SECRET — та же планка, что на бэке (integrations.MinWebhookSecretLen).
// Здесь она только гасит кнопку: слабый секрет обесценивает подпись, и проверку
// всё равно делает сервер независимо от фронта.
const MIN_SECRET = 16

// TestField — проверка адреса: образец с примерными ответами и исход рядом.
//
// Исход неуспеха — не красная ошибка экрана, а строка о получателе: «ответил
// 500» это сведения о нём, а не сбой кабинета.
function TestField({ formId, webhookId }: { formId: string; webhookId: string }) {
  const test = useTestWebhook(formId)
  const result = test.data as WebhookTest | undefined

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate(webhookId)}>
          <Send className="size-4" aria-hidden />
          {test.isPending ? 'Отправляем…' : 'Проверить'}
        </Button>
        {result?.ok && (
          <span className="flex items-center gap-1.5 text-sm text-success">
            <Check className="size-4" aria-hidden />
            Получатель ответил {result.statusCode} за {result.ms} мс
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Отправим образец с вопросами этой формы и пометкой «тестовый». Удачная проверка снимает
        поломку и отправляет ответы, которые ждали очереди.
      </p>
      {result && !result.ok && (
        <p role="alert" className="text-sm text-destructive">
          {result.reason}
        </p>
      )}
      {test.isError && (
        <p role="alert" className="text-sm text-destructive">
          {humanError(test.error)}
        </p>
      )}
    </div>
  )
}

// SignatureHint — как получателю убедиться, что запрос наш. Текст, а не пример
// кода: страницы документации у продукта нет, а имя заголовка и формула — это
// всё, что нужно, чтобы написать проверку на своей стороне.
function SignatureHint() {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">Как проверить, что запрос от нас</p>
      <p className="mt-1">
        В заголовке <span className="font-mono">Trillix-Signature</span> едут время{' '}
        <span className="font-mono">t</span> и подпись <span className="font-mono">v1</span> —
        HMAC-SHA256 строки «время, точка, тело запроса» на вашем секрете. Сверьте её и отбросьте
        запросы старше пяти минут.
      </p>
    </div>
  )
}

// CopyButton — «скопировать» у поля: чёрная служебная кнопка (DESIGN-SYSTEM).
function CopyButton({ value }: { value: string }) {
  return (
    <Button
      variant="utility"
      aria-label="Скопировать секрет"
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => toast.success('Секрет скопирован'))
          .catch(() => toast.error('Не удалось скопировать'))
      }}
    >
      <Copy className="size-4" aria-hidden />
      Копировать
    </Button>
  )
}
