import { useRef, useState } from 'react'
import { AlertCircle, Check, Eye, KeyRound, ListPlus, Plus, Send, X } from 'lucide-react'

import type { Webhook, WebhookHeader, WebhookTest } from '../../entities/integration'
import { getWebhookSecret } from './api'
import {
  useCreateWebhook,
  useDisableWebhookSignature,
  useSetWebhookSecret,
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
//
// У окна ОДНА кнопка сохранения — и в подключении, и в настройке. Подпись,
// название и адрес уезжают одним нажатием, даже когда запросов за ним два:
// вторая кнопка «Сохранить секрет» рядом с первой неразличима в списке кнопок.

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
  // signing — подписывать ли запросы. Предлагается СРАЗУ, в том же окне, что и
  // адрес: подпись — решение того же захода, что и подключение, и человек, уже
  // открывший конфиг получателя, не должен возвращаться сюда вторым заходом.
  const [signing, setSigning] = useState(webhook?.signed ?? false)
  // secret — то, что в поле. Пусто у подписанного вебхука значит «не менять»:
  // секрет в состоянии таба не приезжает, и показывать нам нечего, пока его не
  // спросили отдельной ручкой.
  const [secret, setSecret] = useState('')
  // known — секрет, который уже стоит у вебхука (приехал по «Показать»). Нужен,
  // чтобы показ не превращался в смену: та у получателя ломает проверку.
  const [known, setKnown] = useState<string | null>(null)
  const [showError, setShowError] = useState<unknown>(null)
  const [showing, setShowing] = useState(false)
  // Свои заголовки запроса. Предлагаются той же кнопкой-приёмом, что подпись, и
  // по тому же доводу: решение того же захода, но никому не навязанное.
  const saved = webhook?.headers ?? []
  const [headers, setHeaders] = useState<HeaderRow[]>(() => saved.map((h, i) => ({ id: i, ...h })))
  const [showHeaders, setShowHeaders] = useState(saved.length > 0)
  // Счётчик id новых строк. Читается только в обработчиках: чтение ref во время
  // отрисовки — уже не чистая отрисовка, и линт на это ругается по делу.
  const nextRowID = useRef(saved.length)
  const newRow = (): HeaderRow => ({ id: nextRowID.current++, name: '', value: '' })

  const create = useCreateWebhook(formId)
  const update = useUpdateWebhook(formId)
  const setSecretOf = useSetWebhookSecret(formId)
  const disable = useDisableWebhookSignature(formId)

  const typed = secret.trim()
  // Набор заголовков в том виде, в каком он уедет: выключенный — пустой, и это
  // не «не трогать», а «убрать все».
  const sentHeaders: WebhookHeader[] = showHeaders
    ? headers.map((h) => ({ name: h.name, value: h.value }))
    : []
  // Значение без имени — недописанная строка, а не заголовок: сервер отказал бы,
  // и отказ ради этого гонять незачем.
  const headersBlocked = showHeaders && headers.some((h) => !h.name.trim() && h.value.trim() !== '')
  const saving =
    create.isPending || update.isPending || setSecretOf.isPending || disable.isPending
  const error =
    create.error ?? update.error ?? setSecretOf.error ?? disable.error ?? showError
  // Секрет обязателен, когда подпись ВКЛЮЧАЮТ; у уже подписанного пустое поле
  // значит «не менять», а короткий — промах, и отправлять его нельзя.
  const secretBlocked = signing && (typed === '' ? !webhook?.signed : typed.length < MIN_SECRET)

  async function save() {
    try {
      if (!webhook) {
        await create.mutateAsync({
          name,
          url,
          secret: signing ? typed : undefined,
          // Пустой набор при заведении не шлём вовсе: убирать нечего, а
          // подключение без заголовков — это ровно адрес и название.
          headers: sentHeaders.length > 0 ? sentHeaders : undefined,
        })
        onClose()
        return
      }
      // Адрес шлётся всегда, даже неизменённый: так правящий становится
      // ответственным за доставку и снимает поломку (спека §9).
      await update.mutateAsync({ id: webhook.id, name, url, headers: sentHeaders })
      if (signing && typed !== '' && typed !== known) {
        await setSecretOf.mutateAsync({ webhookId: webhook.id, secret: typed })
      } else if (!signing && webhook.signed) {
        await disable.mutateAsync(webhook.id)
      }
      onClose()
    } catch {
      // Текст отказа показан ниже из состояния мутации: окно остаётся открытым,
      // чтобы человек поправил введённое, а не начинал заново.
    }
  }

  function show() {
    if (!webhook) return
    setShowing(true)
    setShowError(null)
    getWebhookSecret(formId, webhook.id)
      .then((value) => {
        setSecret(value)
        setKnown(value)
      })
      .catch(setShowError)
      .finally(() => setShowing(false))
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

            {signing ? (
              <SecretField
                signed={webhook?.signed ?? false}
                secret={secret}
                onSecret={setSecret}
                known={known !== null}
                showing={showing}
                onShow={webhook ? show : undefined}
                onOff={() => {
                  setSigning(false)
                  setSecret('')
                }}
              />
            ) : (
              <SignatureOffer onOn={() => setSigning(true)} />
            )}

            {showHeaders ? (
              <HeadersField
                rows={headers}
                onRows={setHeaders}
                onAdd={() => setHeaders([...headers, newRow()])}
                onOff={() => {
                  setShowHeaders(false)
                  setHeaders([])
                }}
              />
            ) : (
              <HeadersOffer
                onOn={() => {
                  setShowHeaders(true)
                  setHeaders([newRow()])
                }}
              />
            )}

            {/* Проверка — только у заведённого вебхука: до подключения адрес
                ещё не сохранён, и проверять нечего. */}
            {webhook && <TestField formId={formId} webhookId={webhook.id} />}

            {error != null && (
              <p role="alert" className="flex gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {humanError(error)}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Отмена
              </Button>
              <Button
                disabled={saving || url.trim() === '' || secretBlocked || headersBlocked}
                onClick={save}
              >
                {saving ? 'Сохраняем…' : webhook ? 'Сохранить' : 'Подключить'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// SignatureOffer — предложение подписывать запросы: кнопка, а не тумблер.
//
// Тумблер обещает мгновенное действие («включил — включилось»), а включение
// подписи требует ввести секрет: нажатие открывает поле, и решение считается
// принятым, только когда окно сохранено. Кнопка это и означает.
function SignatureOffer({ onOn }: { onOn: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="outline" onClick={onOn}>
          <KeyRound className="size-4" aria-hidden />
          Подписывать запросы
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Получатель сможет убедиться, что запрос пришёл от нас. Нужно, только если вы
        собираетесь проверять подпись у себя.
      </p>
    </div>
  )
}

// SecretField — секрет подписи: его придумывает автор, продукт своего не
// генерирует (ADR §10). Один секрет годится на все формы человека, и прописать
// его у получателя можно заранее, до подключения.
function SecretField({
  signed,
  secret,
  onSecret,
  known,
  showing,
  onShow,
  onOff,
}: {
  // signed — подпись уже включена у сохранённого вебхука: тогда пустое поле
  // значит «не менять», а действующий секрет можно посмотреть.
  signed: boolean
  secret: string
  onSecret: (value: string) => void
  known: boolean
  showing: boolean
  onShow?: () => void
  onOff: () => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="webhook-secret">Секрет подписи</Label>
        <Button variant="ghost" size="sm" onClick={onOff}>
          Без подписи
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id="webhook-secret"
          autoFocus
          className="h-10 flex-1 font-mono md:text-base"
          placeholder={signed ? 'Не менять' : `От ${MIN_SECRET} символов`}
          value={secret}
          onChange={(e) => onSecret(e.target.value)}
        />
        {signed && !known && onShow && (
          <Button variant="outline" disabled={showing} onClick={onShow}>
            <Eye className="size-4" aria-hidden />
            Показать
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {signed
          ? 'Пустое поле — оставить прежний. Новый секрет начинает действовать сразу: не забудьте поменять его у получателя.'
          : `Придумайте строку от ${MIN_SECRET} символов и пропишите её у получателя — ею подписывается каждый запрос. Один секрет годится на все ваши формы.`}
      </p>
      <SignatureHint />
    </div>
  )
}

// HeaderRow — строка набора на экране. id свой, потому что ключом списка индекс
// быть не может: убрали строку из середины — React переиспользовал бы поля
// соседней вместе с фокусом и выделением.
interface HeaderRow extends WebhookHeader {
  id: number
}

// HeadersOffer — предложение задать свои заголовки. Кнопка, а не поля сразу: их
// не нужно большинству, а нужны они тем, у кого получатель требует ключ.
function HeadersOffer({ onOn }: { onOn: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="outline" onClick={onOn}>
          <ListPlus className="size-4" aria-hidden />
          Свои заголовки
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Уедут с каждым запросом. Так получателю передают ключ: обычно это{' '}
        <span className="font-mono">Authorization</span> со значением{' '}
        <span className="font-mono">Bearer …</span>.
      </p>
    </div>
  )
}

// HeadersField — строки «имя / значение». Набор заменяется целиком тем же
// «Подключить»/«Сохранить», что и всё остальное в окне.
function HeadersField({
  rows,
  onRows,
  onAdd,
  onOff,
}: {
  rows: HeaderRow[]
  onRows: (rows: HeaderRow[]) => void
  onAdd: () => void
  onOff: () => void
}) {
  function patch(id: number, change: Partial<WebhookHeader>) {
    onRows(rows.map((r) => (r.id === id ? { ...r, ...change } : r)))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <Label>Свои заголовки</Label>
        <Button variant="ghost" size="sm" onClick={onOff}>
          Без заголовков
        </Button>
      </div>
      {rows.map((row, i) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input
            aria-label={`Имя заголовка ${i + 1}`}
            placeholder="Authorization"
            className="h-10 w-2/5 font-mono md:text-base"
            value={row.name}
            onChange={(e) => patch(row.id, { name: e.target.value })}
          />
          <Input
            aria-label={`Значение заголовка ${i + 1}`}
            placeholder="Bearer …"
            className="h-10 flex-1 font-mono md:text-base"
            value={row.value}
            onChange={(e) => patch(row.id, { value: e.target.value })}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Убрать заголовок ${i + 1}`}
            onClick={() => onRows(rows.filter((r) => r.id !== row.id))}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
      {rows.length < MAX_HEADERS && (
        <div>
          <Button variant="outline" size="sm" onClick={onAdd}>
            <Plus className="size-4" aria-hidden />
            Ещё заголовок
          </Button>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Имя — латиницей, значение уедет получателю как есть. Наши собственные
        заголовки (<span className="font-mono">Content-Type</span>, подпись) задать нельзя.
      </p>
    </div>
  )
}

// MAX_HEADERS — та же планка, что на бэке (integrations.MaxWebhookHeaders).
const MAX_HEADERS = 10

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
