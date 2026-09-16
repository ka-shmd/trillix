import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'

// Поход к внешнему провайдеру в отдельном окне. Живёт в shared, а не в фиче
// входа: тем же окном и тем же служебным экраном /oauth/done ходит подключение
// интеграций (фаза 25), а импорт одной фичи из другой запрещён (web/CLAUDE.md).
//
// Исход похода. Перечень зеркалит oauthOutcome в
// internal/auth/handler_oauth.go и internal/integrations/handler.go: бэк кладёт код в адрес служебного экрана
// /oauth/done, окно передаёт его вкладке-опекуну, вкладка выбирает по нему
// экран. Разъедутся перечни — вход тихо начнёт заканчиваться «не удалось».
export const oauthOutcomeSchema = z.enum([
  'ok',
  'two_factor',
  'link_required',
  'denied',
  'expired',
  'state',
  'no_email',
  'failed',
  'provider_only',
  'link_ok',
  'link_conflict',
  'link_expired',
  'link_failed',
  // Подключение интеграции (фаза 25) ходит тем же окном и тем же экраном
  // /oauth/done: перечень зеркалит outcome в internal/integrations/handler.go.
  'integration_ok',
  'integration_denied',
  'integration_expired',
  'integration_forbidden',
  'integration_failed',
])

export type OAuthOutcome = z.infer<typeof oauthOutcomeSchema>

// Метка своего сообщения. Origin у постороннего postMessage (расширение
// браузера, наш же фрейм) совпадает с нашим — метка и сверка источника
// отделяют окно входа от всего остального.
export const OAUTH_MESSAGE_SOURCE = 'trillix-oauth'

const oauthMessageSchema = z.object({
  source: z.literal(OAUTH_MESSAGE_SOURCE),
  outcome: oauthOutcomeSchema,
})

// Ниже этого порога окно не открывается: на телефоне «окно» — это фоновая
// вкладка, и ожидание в невидимой вкладке читается как «ничего не произошло».
// Вызывающий обязан оставить обычный переход (кнопка — <a href>).
const POPUP_MIN_VIEWPORT = 640

const POPUP_FEATURES = 'width=560,height=680,menubar=no,toolbar=no,status=no'

// Как часто смотрим, не закрыли ли окно руками. События «окно закрылось»
// браузер не даёт, остаётся опрос.
const WATCH_INTERVAL_MS = 300

interface OAuthPopup {
  // Идёт поход: кнопки заменяются ожиданием.
  waiting: boolean
  // false — окно открыть не удалось или оно неуместно (узкий экран, блокировщик
  // попапов). Тогда вызывающий НИЧЕГО не делает и даёт отработать обычному
  // переходу по ссылке: вход не должен ломаться из-за настроек браузера.
  open: (url: string) => boolean
  cancel: () => void
}

// useOAuthPopup ведёт поход к провайдеру в отдельном окне: открывает его,
// держит состояние ожидания и принимает исход.
export function useOAuthPopup(onOutcome: (outcome: OAuthOutcome) => void): OAuthPopup {
  const [waiting, setWaiting] = useState(false)
  const popupRef = useRef<Window | null>(null)
  // Обработчик исхода живёт в ref: слушатель вешается на поход, а колбэк
  // вызывающего пересоздаётся каждым рендером — иначе слушатель переподписывался
  // бы вместе со сторожем и сбрасывал его отсчёт.
  const onOutcomeRef = useRef(onOutcome)
  useEffect(() => {
    onOutcomeRef.current = onOutcome
  })

  const stop = useCallback(() => {
    popupRef.current?.close()
    popupRef.current = null
    setWaiting(false)
  }, [])

  useEffect(() => {
    if (!waiting) return

    function handleMessage(e: MessageEvent) {
      // Три условия, и все три обязательны: свой origin, ровно наше окно и
      // знакомая форма сообщения. Из сообщения берётся ТОЛЬКО код исхода —
      // путь вкладка строит сама, иначе postMessage стал бы управляемым
      // редиректом по кабинету.
      if (e.origin !== window.location.origin) return
      if (e.source !== popupRef.current) return
      const msg = oauthMessageSchema.safeParse(e.data)
      if (!msg.success) return

      stop()
      onOutcomeRef.current(msg.data.outcome)
    }
    window.addEventListener('message', handleMessage)

    // Сторож закрытого окна. «Закрыто» подряд дважды, а не единожды: окно
    // закрывается сразу после postMessage, и сообщение может ещё лежать в
    // очереди задач вкладки — сдаться на первом же тике значит иногда терять
    // готовый исход и объявлять успешный вход отменённым.
    let closedTicks = 0
    const watch = window.setInterval(() => {
      const win = popupRef.current
      if (win && !win.closed) {
        closedTicks = 0
        return
      }
      closedTicks += 1
      if (closedTicks >= 2) stop()
    }, WATCH_INTERVAL_MS)

    return () => {
      window.removeEventListener('message', handleMessage)
      window.clearInterval(watch)
    }
  }, [waiting, stop])

  const open = useCallback((url: string) => {
    if (window.innerWidth < POPUP_MIN_VIEWPORT) return false
    // Синхронно в обработчике клика: отложенный window.open блокировщик
    // попапов режет, потому что жеста человека за ним уже не видно.
    // Прошлое окно закрываем САМИ, до открытия нового.
    //
    // Мина: имя окна у похода одно (`trillix-oauth`) — так их не плодится по
    // штуке на попытку. Но живое окно с этим именем повторный window.open не
    // открывает заново: он грузит адрес в него, не поднимая наверх, и браузер
    // показывает прежнюю страницу провайдера, пока новая не приедет. Снаружи это
    // выглядит как «та же ошибка мгновенно» — то есть как отсутствие второй
    // попытки. Поймано на живой проверке подключения аккаунта Яндекса.
    popupRef.current?.close()
    popupRef.current = null

    const win = window.open(url, 'trillix-oauth', POPUP_FEATURES)
    if (!win) return false
    // Наверх — на каждой попытке: открытое окно браузер сам не фокусирует, если
    // человек успел вернуться во вкладку кабинета.
    win.focus()

    popupRef.current = win
    setWaiting(true)
    return true
  }, [])

  return { waiting, open, cancel: stop }
}
