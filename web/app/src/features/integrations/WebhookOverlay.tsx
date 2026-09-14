import { useRef, useState } from 'react'
import { AlertCircle, Check, Eye, Plus, Send, Trash2 } from 'lucide-react'

import type { Webhook, WebhookHeader, WebhookTest } from '../../entities/integration'
import { getWebhookSecret } from './api'
import {
  useCreateWebhook,
  useDisableWebhookSignature,
  useSetWebhookSecret,
  useTestWebhook,
  useUpdateWebhook,
} from './queries'
import { CompactAction } from './CompactAction'
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
                className="md:text-base"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="webhook-name">Название</Label>
              <Input
                id="webhook-name"
                placeholder="CRM"
                className="md:text-base"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
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
              <SignatureOffer
                onOn={() => {
                  setSigning(true)
                  setSecret(newSecret())
                }}
              />
            )}

            {showHeaders ? (
              <HeadersField
                rows={headers}
                onPatch={(id, change) =>
                  setHeaders(headers.map((r) => (r.id === id ? { ...r, ...change } : r)))
                }
                onRemove={(id) => {
                  const left = headers.filter((r) => r.id !== id)
                  setHeaders(left)
                  // Убрали последнюю строку — блок схлопывается в предложение:
                  // отдельной кнопки «без заголовков» нет, и пустой список полей
                  // был бы ровно ею, только без надписи (решение владельца).
                  if (left.length === 0) setShowHeaders(false)
                }}
                onAdd={() => setHeaders([...headers, newRow()])}
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
            {webhook && (
              <TestField formId={formId} webhookId={webhook.id} enabled={webhook.enabled} />
            )}

            {error != null && (
              <p role="alert" className="flex gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {humanError(error)}
              </p>
            )}

            {/* Одно действие во всю ширину, как в окне Таблиц. «Отмены» нет:
                уйти не сохранив можно крестиком окна и Escape, а кнопка рядом с
                действием делала бы вид, что отказ — такой же шаг, как согласие. */}
            <Button
              size="lg"
              disabled={saving || url.trim() === '' || secretBlocked || headersBlocked}
              onClick={save}
            >
              {saving ? 'Сохраняем…' : webhook ? 'Сохранить' : 'Подключить'}
            </Button>
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
//
// Облик — общий CompactAction, тот же, что у действий над аккаунтом Google:
// предложение это не вопрос анкеты наравне с адресом, и объяснять его до нажатия
// нечем — за объяснением человек нажимает (решение владельца).
function SignatureOffer({ onOn }: { onOn: () => void }) {
  return (
    <div>
      <CompactAction icon={Plus} label="Подписывать запросы" onClick={onOn} />
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
      <Label htmlFor="webhook-secret">Секрет подписи</Label>
      <div className="flex items-center gap-2">
        <Input
          id="webhook-secret"
          autoFocus
          className="flex-1 font-mono md:text-base"
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
        {/* Корзина после поля — тот же приём, что у строки заголовка: убирает
            подпись целиком. Отдельной кнопки «без подписи» нет — у поля, которое
            можно убрать, ей рядом делать нечего (решение владельца). */}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Убрать подпись"
          onClick={onOff}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      </div>
      {/* Единственное, что блок говорит сверх полей, и только у подписанного:
          пустое поле здесь значит «не менять», а смена секрета ломает проверку у
          получателя в ту же секунду. Это про состояние поля, а не про устройство
          подписи — устройство описано в INTEGRATIONS.md. */}
      {signed && (
        <p className="text-sm text-muted-foreground">
          Новый секрет начинает действовать сразу: не забудьте поменять его у получателя.
        </p>
      )}
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
// не нужно большинству, а нужны они тем, у кого получатель требует ключ. Облик и
// довод про отсутствие подписи под кнопкой — те же, что у SignatureOffer.
function HeadersOffer({ onOn }: { onOn: () => void }) {
  return (
    <div>
      <CompactAction icon={Plus} label="Свои заголовки" onClick={onOn} />
    </div>
  )
}

// HeadersField — строки «имя / значение». Набор заменяется целиком тем же
// «Подключить»/«Сохранить», что и всё остальное в окне.
function HeadersField({
  rows,
  onPatch,
  onRemove,
  onAdd,
}: {
  rows: HeaderRow[]
  onPatch: (id: number, change: Partial<WebhookHeader>) => void
  onRemove: (id: number) => void
  onAdd: () => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Свои заголовки</Label>
      {rows.map((row, i) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input
            aria-label={`Имя заголовка ${i + 1}`}
            placeholder="Имя"
            className="w-2/5 font-mono md:text-base"
            value={row.name}
            onChange={(e) => onPatch(row.id, { name: e.target.value })}
          />
          <Input
            aria-label={`Значение заголовка ${i + 1}`}
            placeholder="Значение"
            className="flex-1 font-mono md:text-base"
            value={row.value}
            onChange={(e) => onPatch(row.id, { value: e.target.value })}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Убрать заголовок ${i + 1}`}
            onClick={() => onRemove(row.id)}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
      {/* Кнопка стоит ПОД «Значением» и кончается там же, где оно: пустая клетка
          держит колонку корзин, иначе кнопка встала бы под ними. Под списком,
          а не над ним, — она продолжает набранное, и смотреть на неё нужно после
          строк, а не до. */}
      {rows.length < MAX_HEADERS && (
        <div className="flex items-center gap-2">
          <div className="flex-1" aria-hidden />
          <CompactAction icon={Plus} label="Ещё заголовок" onClick={onAdd} />
          <div className="size-9 shrink-0" aria-hidden />
        </div>
      )}
    </div>
  )
}

// MAX_HEADERS — та же планка, что на бэке (integrations.MaxWebhookHeaders).
const MAX_HEADERS = 10

// newSecret — секрет, которым поле заполняется при включении подписи. Придумывать
// строку человеку незачем: ему нужно, чтобы подпись работала, а не авторство
// ключа. Кто хочет свой — стирает и вписывает.
//
// Это НЕ возврат генерации на сервер (её отменил владелец, ADR §10, четвёртый
// круг): значение просто стоит в поле и уезжает обычной отправкой окна, как если
// бы его вписали руками. Отменяли другое — «сервер выдал, скопируй отсюда и унеси
// туда», из-за чего подпись и читалась обязанностью.
//
// UUID, а не своя строка с префиксом: 36 знаков латиницы и дефисов, вчетверо
// длиннее планки, и ровно так же выглядит секрет у Tally.
const newSecret = () => crypto.randomUUID()

// MIN_SECRET — та же планка, что на бэке (integrations.MinWebhookSecretLen).
// Здесь она только гасит кнопку: слабый секрет обесценивает подпись, и проверку
// всё равно делает сервер независимо от фронта.
const MIN_SECRET = 16

// TestField — проверка адреса: образец с примерными ответами и исход рядом.
//
// Исход неуспеха — не красная ошибка экрана, а строка о получателе: «ответил
// 500» это сведения о нём, а не сбой кабинета.
function TestField({
  formId,
  webhookId,
  enabled,
}: {
  formId: string
  webhookId: string
  enabled: boolean
}) {
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
      {/* У выключенного вебхука обещать доставку накопленного нельзя: доставщик
          в него не пойдёт, пока не включат, и «ответил 200» под таким обещанием
          читался бы как «поехало». */}
      <p className="text-sm text-muted-foreground">
        {enabled
          ? 'Отправим образец с вопросами этой формы и пометкой «тестовый». Удачная проверка снимает поломку и отправляет ответы, которые ждали очереди.'
          : 'Отправим образец с вопросами этой формы и пометкой «тестовый». Вебхук выключен — ответы не поедут, пока не включите его.'}
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

