import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useBlocker } from '@tanstack/react-router'
import { toast } from 'sonner'

import { MAX_REDIRECT_URL_LEN, MAX_THANK_YOU_TEXT_LEN } from '@entities/formSchema'
import {
  MAX_CLOSED_MESSAGE_LEN,
  MAX_CLOSED_TITLE_LEN,
  MAX_NOTIFY_BODY_LEN,
  MAX_NOTIFY_FROM_NAME_LEN,
  MAX_NOTIFY_SUBJECT_LEN,
  type FormDetail,
} from '../../../entities/form'
import { ApiError } from '../../../shared/api/errors'
import { PageFooter } from '../../../shared/page/PageFooter'
import { Section } from '../../../shared/page/Section'
import { ProTag } from '../../../shared/ProTag'
import { PlanUpsell } from '../../plan/PlanUpsell'
import { useFeatureAllowed } from '../../plan/useFeature'
import {
  useReopenForm,
  useUnpublishForm,
  useUpdateAfterSubmit,
  useUpdateBranding,
  useUpdateCloseSettings,
  useUpdateCollectPartial,
  useUpdateNotifyEmail,
  useUpdateNotifyOnSubmission,
  useUpdateProgress,
} from '../queries'

import {
  closeSettingsValue,
  isDirty,
  notifyEmailValue,
  mergeServer,
  pendingChanges,
  redirectValue,
  sameSettings,
  settingsFromForm,
  validateSettings,
  type SettingsDraft,
} from './draft'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

// Настройки формы — то, чего на полотне не видно: что делать после отправки, как
// выглядит форма у респондента поверх документа, когда прекратить приём.
//
// РАЗДЕЛ ФОРМЫ, а не режим редактора (решение владельца 2026-08-26, отменяет прежнее
// «ссылки на настройки нет»): у настроек есть свой адрес, они стоят в одном ряду
// с «Поделиться · Аналитика · Ответы · Интеграции», и на них можно послать ссылкой —
// чем и пользуется вкладка «Частичные», отправляя сюда за тумблером сбора.
//
// ОДНА КНОПКА НА ВСЮ СТРАНИЦУ (решение владельца 2026-08-29, отменяет прежние
// «Сохранить» в каждом разделе и мгновенные тумблеры): страница целиком —
// черновик, сохраняется он подвалом внизу. Тумблеры входят в тот же черновик, и
// пока кнопка не нажата, на сервере их положение прежнее.
//
// За одной кнопкой стоят ШЕСТЬ разных запросов, и это не деталь реализации, а
// причина порядка отправки. «После отправки» — поля СХЕМЫ: правятся PATCH'ем
// черновика с оптимистичной блокировкой по `updatedAt`. Остальные пять — живые
// колонки `forms` со своими мутациями, схемы не касаются вовсе, но каждая двигает
// тот самый `updatedAt`. Поэтому схема уезжает ПЕРВОЙ: пойди она следом, её
// блокировка сработала бы на правку, только что сделанную этой же кнопкой.
//
// Уход с несохранёнными правками стережёт диалог поверх навигации роутера.
export function FormSettingsView({ form }: { form: FormDetail }) {
  const saved = settingsFromForm(form)

  const [draft, setDraft] = useState(saved)
  // Деталь формы — источник истины: её меняют мимо этой страницы (редактор, другая
  // вкладка, тумблер бейджа на экране «Встроить»), и черновик обязан догнать.
  // Сверка в рендере, а не эффектом: эффект здесь дал бы лишний каскадный рендер
  // (react-hooks/set-state-in-effect). Догоняются только те поля, что изменились на
  // сервере (mergeServer) — иначе частично удавшееся сохранение стирало бы
  // неудавшуюся половину правок.
  const [synced, setSynced] = useState(saved)
  if (!sameSettings(synced, saved)) {
    setDraft((d) => mergeServer(d, synced, saved))
    setSynced(saved)
  }

  const updateAfterSubmit = useUpdateAfterSubmit()
  const updateClose = useUpdateCloseSettings()
  const unpublish = useUnpublishForm()
  const reopen = useReopenForm()
  const updateNotify = useUpdateNotifyOnSubmission()
  const updatePartial = useUpdateCollectPartial()
  const updateProgress = useUpdateProgress()
  const updateNotifyEmail = useUpdateNotifyEmail()
  const updateBranding = useUpdateBranding()

  // Гейты тарифа. Оба спрашиваются у снимка плана пространства, и оба ДЕРЖАТ САМ
  // КОНТРОЛ, а не отказывают после нажатия (тот же приём, что у бейджа на экране
  // «Встроить», EMBED §10): попытка включить платное на бесплатном тарифе ничего не
  // меняет и открывает разговор о тарифе. Направления разные — сбор незавершённых
  // гейтится на ВКЛЮЧЕНИИ, бейдж на СНЯТИИ.
  const canCollectPartial = useFeatureAllowed('submissions_partial')
  const canRemoveBadge = useFeatureAllowed('form_branding')
  // Настройка письма — платная целиком (решение владельца 2026-08-29): на бесплатном
  // плане поля видны, но не редактируются, а попытка печатать открывает разговор о
  // тарифе. Бэк отвергает такую правку сам (402) — снимок плана мог устареть.
  const canCustomizeEmail = useFeatureAllowed('form_notify_email')
  const [upsell, setUpsell] = useState(false)

  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const invalid = validateSettings(draft)
  const anyInvalid =
    invalid.url || invalid.urlMissing || invalid.limit || invalid.replyTo || invalid.closeAt
  const dirty = isDirty(saved, draft)

  // Уход с несохранёнными правками — осознанный. Блокируется НАВИГАЦИЯ роутера
  // (табы, крошки, «Назад» браузера) плюс закрытие вкладки: страница живёт внутри
  // оболочки формы, и уйти с неё можно десятком ссылок, а не одной кнопкой «назад»,
  // как было в редакторе.
  const blocker = useBlocker({ shouldBlockFn: () => dirty, withResolver: true })

  // Правка гасит прошлую неудачу: «Не удалось сохранить» относится к нажатию
  // кнопки, а не к странице вообще, и висеть над уже переписанными полями оно не
  // должно.
  function set<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
    if (failed) setFailed(false)
  }

  // Запросы идут ПОСЛЕДОВАТЕЛЬНО и не отменяют друг друга: провалившийся раздел
  // оставляет свои правки в черновике (сравнение с деталью формы их и держит
  // «несохранёнными»), удавшиеся — уезжают. Полу-сохранение честнее отката: оно
  // видно на самой странице, а откат пришлось бы объяснять словами.
  async function save() {
    if (anyInvalid || saving) return
    const jobs = pendingChanges(saved, draft)
    setSaving(true)
    let broke = false

    if (jobs.afterSubmit) {
      try {
        await updateAfterSubmit.mutateAsync({
          form,
          thankYouText: draft.thankYouText,
          redirectUrl: redirectValue(draft),
        })
      } catch {
        broke = true
      }
    }

    if (jobs.close) {
      try {
        await updateClose.mutateAsync({ id: form.id, settings: closeSettingsValue(draft) })
      } catch {
        broke = true
      }
    }

    // Статус — не колонка настроек, а две отдельные ручки. Открытие НЕ публикует
    // новой версии: респонденты возвращаются к той же, что видели до закрытия.
    if (jobs.closedNow) {
      try {
        if (draft.closedNow) await unpublish.mutateAsync(form.id)
        else await reopen.mutateAsync(form.id)
      } catch {
        broke = true
      }
    }

    if (jobs.notify) {
      try {
        await updateNotify.mutateAsync({ id: form.id, slug: form.slug, enabled: draft.notify })
      } catch {
        broke = true
      }
    }

    if (jobs.notifyEmail) {
      try {
        await updateNotifyEmail.mutateAsync({ id: form.id, value: notifyEmailValue(draft) })
      } catch (e: unknown) {
        broke = true
        // 402 — тариф закрылся, пока страница была открыта (даунгрейд в соседней
        // вкладке). Правки остаются в черновике: сбросить их за автора нельзя, он их
        // печатал, — но кнопка теперь честно говорит, что не сохранилось.
        if (e instanceof ApiError && e.code === 'plan_required') {
          toast.error('Настройка письма доступна на платном тарифе')
        }
      }
    }

    if (jobs.progress) {
      try {
        await updateProgress.mutateAsync({ id: form.id, show: draft.progress })
      } catch {
        broke = true
      }
    }

    if (jobs.branding) {
      try {
        await updateBranding.mutateAsync({ id: form.id, show: draft.branding })
      } catch {
        broke = true
      }
    }

    if (jobs.partial) {
      try {
        await updatePartial.mutateAsync({ id: form.id, slug: form.slug, enabled: draft.partial })
      } catch (e: unknown) {
        broke = true
        // Отказ тарифа — единственная неудача, которую повтор той же кнопкой не
        // чинит. Тумблер возвращается в серверное положение сам: оставь его
        // включённым, и страница вечно висела бы «несохранённой». Дублирует гейт
        // контрола выше НЕ зря: снимок плана мог устареть (даунгрейд в соседней
        // вкладке), и правду говорит только ответ сервера.
        if (e instanceof ApiError && e.code === 'plan_required') {
          set('partial', form.collectPartial)
          toast.error('Сбор незавершённых ответов доступен на платном тарифе')
        }
      }
    }

    setSaving(false)
    setFailed(broke)
    if (broke) toast.error('Не удалось сохранить. Попробуйте ещё раз.')
  }

  return (
    <div className="flex flex-col gap-12">
      <Section title="Основные настройки">
        {/* Линия под заголовком — верхняя граница самого списка, а не отдельный
            элемент: ряд строк уже разделён `divide-y`, и общий `border-t` делает
            первую строку такой же, как остальные. */}
        <div className="flex flex-col divide-y border-t">
          <SettingRow
            id="redirect"
            label="Переадресация"
            description="После отправки переведём респондента на ваш адрес."
            checked={draft.redirectOn}
            onChange={(v) => set('redirectOn', v)}
          >
            {/* Без видимой подписи (решение владельца): поле одно, стоит под своей
                настройкой и объяснено плейсхолдером. Имя для скринридера остаётся —
                `aria-label`: без него поле называлось бы «edit», а по чему оно, из
                строки настройки выше в дереве доступности не следует. */}
            <Input
              id="redirect-url"
              type="url"
              inputMode="url"
              aria-label="Ссылка перехода"
              value={draft.redirectUrl}
              placeholder="https://example.com/"
              maxLength={MAX_REDIRECT_URL_LEN}
              aria-invalid={invalid.url}
              aria-describedby={invalid.url ? 'redirect-url-hint' : undefined}
              onChange={(e) => set('redirectUrl', e.target.value)}
            />
            {/* Строка под полем — ТОЛЬКО ошибка. Пояснение формата под пустым полем
                («абсолютный адрес: http:// или https://») снято решением владельца:
                оно повторяло плейсхолдер и висело подсказкой там, где ошибки нет. */}
            {invalid.url && (
              <p id="redirect-url-hint" className="mt-1.5 text-sm text-destructive" role="alert">
                Ссылка должна начинаться с http:// или https://
              </p>
            )}
          </SettingRow>

          <SettingRow
            id="progress"
            label="Шкала прогресса"
            description="Показывает респонденту, какую часть формы он уже прошёл, и подталкивает дойти до конца."
            checked={draft.progress}
            onChange={(v) => set('progress', v)}
          />

          {/* Якорь строки: вкладка «Частичные» ведёт сюда ссылкой с хешем, и человек,
              пришедший за тумблером сбора, обязан увидеть под курсором именно его, а
              не верх страницы настроек. */}
          <SettingRow
            id="partial"
            label="Частичные ответы"
            description="Форма запомнит набранное, даже если человек её не отправит. Респондент увидит об этом предупреждение, а собранное появится на вкладке «Частичные»."
            pro
            checked={draft.partial}
            // Единственный тумблер продукта, который включает СБОР данных, а не их
            // показ: включить его молча нельзя, поэтому предупреждение респонденту
            // живёт от того же флага.
            onChange={(v) => {
              if (v && !canCollectPartial) {
                setUpsell(true)
                return
              }
              set('partial', v)
            }}
          />

          <SettingRow
            id="branding"
            label="Брендинг Trillix"
            description="Подпись «Сделано в Trillix» на вашей форме."
            pro
            checked={draft.branding}
            // Гейт стоит только на СНЯТИИ бейджа; вернуть его вправе любой тариф.
            // Право спрашивается ещё раз при отдаче публичной формы (BILLING.md),
            // поэтому даунгрейд возвращает бейдж сам, ничего не стирая.
            onChange={(v) => {
              if (!v && !canRemoveBadge) {
                setUpsell(true)
                return
              }
              set('branding', v)
            }}
          />
        </div>
      </Section>

      <Section title="Email-уведомления">
        <div className="flex flex-col divide-y border-t">
          {/* Частые ответы склеиваются в одно письмо — троттлинг на бэкенде. */}
          <SettingRow
            id="notify-on-submission"
            label="Уведомления мне"
            description="Письмо на вашу почту о каждом новом ответе на форму."
            checked={draft.notify}
            onChange={(v) => set('notify', v)}
          >
            <NotifyEmailFields
              draft={draft}
              set={set}
              replyToInvalid={invalid.replyTo}
              editable={canCustomizeEmail}
              onLocked={() => setUpsell(true)}
            />
          </SettingRow>

          {/* ЗАГЛУШКА (решение владельца 2026-08-29): строка нарисована, за ней
              ничего нет. Стоит здесь намеренно и с красной меткой — чтобы дыра была
              видна на самом экране, а не только в очереди задач. Что делать —
              `BACKLOG.md`, пункт «Почта формы» — там же подстановки и PDF. Метка и
              `disabled` снимаются вместе с реализацией. */}
          <SettingRow
            id="notify-respondent"
            label="Уведомления респонденту"
            description="Письмо респонденту после отправки формы: свой текст и, если нужно, PDF с его ответами вложением."
            checked={false}
            onChange={() => undefined}
            disabled
            stub="Заглушка: строка нарисована, отправки нет. Задача — в BACKLOG.md, «Почта формы»."
          />
        </div>
      </Section>

      <Section
        title="После отправки"
        description="Что респондент увидит, когда отправит ответ. Нужен экран посложнее — соберите страницу «Спасибо» на полотне: включите тумблер на последнем разрыве страницы, и она заменит этот текст."
      >
        <div>
          <Label htmlFor="thank-you-text">Текст благодарности</Label>
          <Textarea
            id="thank-you-text"
            value={draft.thankYouText}
            placeholder="Спасибо! Ваш ответ отправлен."
            maxLength={MAX_THANK_YOU_TEXT_LEN}
            onChange={(e) => set('thankYouText', e.target.value)}
            className="mt-1.5"
          />
        </div>
      </Section>

      <Section title="Доступность">
        <div className="flex flex-col divide-y border-t">
          {/* ЗАГЛУШКА (решение владельца 2026-08-29): пароля на форму нет нигде —
              это сквозная работа (колонка, проверка на публичном пути, экран ввода в
              рендерере, свой rate limit), и она идёт отдельным заходом. Строка стоит
              здесь с красной меткой, чтобы дыра была видна на самом экране. Что
              делать — `BACKLOG.md`, пункт «Пароль на форму». */}
          <SettingRow
            id="form-password"
            label="Пароль на форму"
            description="Респондент увидит вопросы, только когда введёт пароль."
            checked={false}
            onChange={() => undefined}
            disabled
            stub="Заглушка: пароля пока нет. Задача — в BACKLOG.md, «Пароль на форму»."
          />

          {/* Закрытие — это СТАТУС формы, а не колонка настроек: тумблер уезжает
              отдельными ручками (unpublish/reopen), а не фасетом closeSettings.
              Черновик закрывать нечего — приём у него ещё не начинался. */}
          <SettingRow
            id="form-closed"
            label="Закрыть форму"
            description={
              form.status === 'draft'
                ? 'Форма ещё не опубликована — принимать ответы она пока и не начинала.'
                : 'Отвечать на форму больше нельзя. Открыть обратно можно тем же тумблером: та же версия, без повторной публикации.'
            }
            checked={draft.closedNow}
            disabled={form.status === 'draft'}
            onChange={(v) => set('closedNow', v)}
          />

          <SettingRow
            id="close-at"
            label="Закрыть в назначенное время"
            description="Форма перестанет принимать ответы после этого момента."
            checked={draft.closeOn}
            onChange={(v) => set('closeOn', v)}
          >
            <Input
              id="close-at-value"
              type="datetime-local"
              aria-label="Дата и время закрытия"
              aria-invalid={invalid.closeAt}
              value={draft.closeLocal}
              onChange={(e) => set('closeLocal', e.target.value)}
            />
            {/* Пояс НЕ выбирается (решение владельца): дата и время читаются в поясе
                браузера — том же, в котором автор их набирает. Подпись обязательна:
                без неё «в 23:59» у формы, которую закрывают из другой страны,
                двусмысленно. */}
            <p className="mt-1.5 text-sm text-muted-foreground">
              Время вашего часового пояса — того, в котором работает этот браузер.
            </p>
          </SettingRow>

          <SettingRow
            id="response-limit"
            label="Ограничить число ответов"
            description="Форма закроется сама, набрав столько ответов."
            checked={draft.limitOn}
            onChange={(v) => set('limitOn', v)}
          >
            <Input
              id="response-limit-value"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              aria-label="Сколько ответов принять"
              aria-invalid={invalid.limit}
              value={draft.limit}
              placeholder="Например, 100"
              onChange={(e) => set('limit', e.target.value)}
            />
            {invalid.limit && (
              <p className="mt-1.5 text-sm text-destructive" role="alert">
                Лимит — целое число больше нуля.
              </p>
            )}
          </SettingRow>

          <SettingRow
            id="closed-message"
            label="Сообщение о закрытии"
            description="Что увидит человек, открывший форму, которая больше не принимает ответы."
            checked={draft.closedMessageOn}
            onChange={(v) => set('closedMessageOn', v)}
          >
            <Input
              id="closed-title"
              aria-label="Заголовок сообщения"
              value={draft.closedTitle}
              placeholder="Приём ответов закрыт"
              maxLength={MAX_CLOSED_TITLE_LEN}
              onChange={(e) => set('closedTitle', e.target.value)}
            />
            <Textarea
              id="closed-message-text"
              aria-label="Текст сообщения"
              value={draft.closedMessage}
              placeholder="Спасибо всем, кто успел ответить."
              maxLength={MAX_CLOSED_MESSAGE_LEN}
              onChange={(e) => set('closedMessage', e.target.value)}
              className="mt-2"
            />
            <p className="mt-1.5 text-sm text-muted-foreground">
              Пусто — заголовком останется название формы, а текстом — наш обычный «приём ответов
              закрыт».
            </p>
          </SettingRow>
        </div>
      </Section>

      {/* Колонка та же, что у страницы (`default` в оболочке _manage): кнопка
          стоит под правым краем полей, из которых сохраняет. */}
      <PageFooter width="default">
        <div className="flex items-center justify-end gap-3">
          {/* Красным подписывается ОШИБКА, а не незаконченность: «укажите ссылку»
              относится к полю, в которое человек ещё не печатал, и краснеть ему не за
              что — кнопка и так не даётся. */}
          <span
            className={`text-sm ${failed || invalid.url || invalid.limit || invalid.replyTo ? 'text-destructive' : 'text-muted-foreground'}`}
            role="status"
          >
            {invalid.url
              ? 'Проверьте ссылку перехода'
              : invalid.urlMissing
                ? 'Укажите ссылку перехода'
                : invalid.replyTo
                  ? 'Проверьте адрес для ответов'
                  : invalid.limit
                    ? 'Проверьте лимит'
                    : failed
                      ? 'Не удалось сохранить'
                      : dirty
                        ? 'Есть несохранённые изменения'
                        : 'Всё сохранено'}
          </span>
          <Button onClick={() => void save()} disabled={!dirty || anyInvalid || saving}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </Button>
        </div>
      </PageFooter>

      <PlanUpsell open={upsell} onOpenChange={setUpsell} />

      <AlertDialog open={blocker.status === 'blocked'}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Есть несохранённые изменения</AlertDialogTitle>
            <AlertDialogDescription>
              Настройки формы изменены, но не сохранены. Если уйти сейчас, правки пропадут.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>Остаться</AlertDialogCancel>
            <AlertDialogAction onClick={() => blocker.proceed?.()}>
              Уйти без сохранения
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// Меню письма о новом ответе — то, что раскрывается под включённым тумблером.
// Собрано коробкой из строк, как бланк письма: слева подпись поля, справа значение.
//
// ДВЕ СТРОКИ ЗАМОРОЖЕНЫ, и это не «пока не сделали». Адрес отправителя один на
// сервис: письма уходят с нашего домена, и подменённый адрес стоил бы репутации
// всей почты сервиса — автор меняет только ИМЯ рядом с ним. Получатель — владелец
// пространства: письма шлём мы, и произвольный адрес в этом поле превратил бы форму
// в рассыльщик.
//
// Подстановок (@Форма, @Все ответы) ЕЩЁ НЕТ — текст уходит как есть; задача в
// BACKLOG.md, там же PDF-вложение. Поэтому чекбокс PDF нарисован выключенным и с
// красной меткой: строка есть, вложения нет.
function NotifyEmailFields({
  draft,
  set,
  replyToInvalid,
  editable,
  onLocked,
}: {
  draft: SettingsDraft
  set: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void
  replyToInvalid: boolean
  editable: boolean
  onLocked: () => void
}) {
  // На бесплатном плане поля видны и НЕ редактируются: `readOnly`, а не `disabled`,
  // — выключенное поле не ловит ни клика, ни фокуса, и объяснить, почему оно не
  // печатается, было бы негде. Клик по такому полю открывает разговор о тарифе.
  const lock = editable ? {} : { readOnly: true, onFocus: onLocked, onClick: onLocked }
  const cell = 'w-full border-0 bg-transparent px-0 shadow-none focus-visible:ring-0'

  return (
    <div className="rounded-lg border">
      <Row label="Имя отправителя">
        <Input
          {...lock}
          aria-label="Имя отправителя"
          value={draft.notifyFromName}
          placeholder="Trillix"
          maxLength={MAX_NOTIFY_FROM_NAME_LEN}
          onChange={(e) => set('notifyFromName', e.target.value)}
          className={cell}
        />
      </Row>
      <Row label="От кого">
        <span className="text-sm text-muted-foreground">
          служебный адрес Trillix — его менять нельзя
        </span>
      </Row>
      <Row label="Кому">
        <span className="text-sm text-muted-foreground">
          владельцу пространства, на адрес его аккаунта
        </span>
      </Row>
      <Row label="Адрес для ответов">
        <div className="w-full">
          <Input
            {...lock}
            type="email"
            inputMode="email"
            aria-label="Адрес для ответов"
            aria-invalid={replyToInvalid}
            value={draft.notifyReplyTo}
            placeholder="Куда ответит ваш почтовый клиент"
            onChange={(e) => set('notifyReplyTo', e.target.value)}
            className={cell}
          />
          {replyToInvalid && (
            <p className="pb-1 text-sm text-destructive" role="alert">
              Нужен адрес вида name@example.com
            </p>
          )}
        </div>
      </Row>
      <Row label="Тема">
        <Input
          {...lock}
          aria-label="Тема письма"
          value={draft.notifySubject}
          placeholder="Новые ответы в Trillix"
          maxLength={MAX_NOTIFY_SUBJECT_LEN}
          onChange={(e) => set('notifySubject', e.target.value)}
          className={cell}
        />
      </Row>
      <div className="border-t px-3 py-2">
        <Textarea
          {...lock}
          aria-label="Текст письма"
          value={draft.notifyBody}
          placeholder="Оставьте пустым, чтобы письмо ушло обычным текстом со ссылкой на ответы."
          maxLength={MAX_NOTIFY_BODY_LEN}
          rows={5}
          onChange={(e) => set('notifyBody', e.target.value)}
          className="min-h-24 w-full resize-y border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        />
      </div>
      {/* ЗАГЛУШКА: вложения нет, задача в BACKLOG.md вместе с подстановками. */}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
        <Checkbox id="notify-pdf" checked={false} disabled />
        <Label htmlFor="notify-pdf" className="font-normal text-muted-foreground">
          Прикрепить PDF с ответами
        </Label>
        <span className="text-sm font-medium text-destructive">— заглушка, PDF пока не делаем</span>
      </div>
      {!editable && (
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-sm text-muted-foreground">
          <ProTag />
          <span>Менять письмо можно на платном тарифе.</span>
          <button type="button" className="underline underline-offset-2" onClick={onLocked}>
            Посмотреть тарифы
          </button>
        </div>
      )}
    </div>
  )
}

// Строка бланка: подпись слева, значение справа. Подпись фиксированной ширины —
// иначе поля начинались бы в пяти разных местах и бланк перестал бы читаться
// колонкой.
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b px-3 py-1 last:border-b-0">
      <span className="w-40 shrink-0 text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

// Строка настройки: подпись, под ней пояснение, у правого края тумблер. Всё, что
// настройке нужно СВЕРХ включения (адрес переадресации), стоит ниже и появляется
// только с включённым тумблером — выключенная настройка не занимает экран полями,
// которые всё равно не работают.
//
// Метка платного тарифа стоит ВСЕГДА, а не только на бесплатном плане: она называет
// условие, при котором настройка сработает, а `useFeatureAllowed` отвечает «можно»
// на всех планах, где ключ открыт (BILLING §6) — под условием `!allowed` метка не
// показалась бы там вообще никому. Тот же приём у бейджа на экране «Встроить».
function SettingRow({
  id,
  label,
  description,
  checked,
  onChange,
  pro,
  disabled,
  stub,
  children,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
  pro?: boolean
  disabled?: boolean
  // stub — текст красной метки «за строкой ничего нет». Настройка, нарисованная и
  // неработающая, обязана говорить об этом на самом экране: иначе про неё узнают
  // от человека, который её включил и ждал письма.
  stub?: string
  children?: React.ReactNode
}) {
  const switchId = `${id}-switch`
  return (
    <div id={id} className="py-4">
      <div className="flex items-start justify-between gap-6">
        {/* Значок метки стоит СЛЕВА ОТ ВСЕЙ СТРОКИ, а не у подписи: он относится к
            настройке целиком, и в ряду одинаковых строк красное пятно у левого края
            видно с одного взгляда. */}
        <div className="flex min-w-0 gap-2">
          {stub && (
            <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={switchId} className="text-base font-semibold">
                {label}
              </Label>
              {pro && <ProTag />}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            {stub && (
              <p className="mt-1 text-sm font-medium text-destructive" role="status">
                {stub}
              </p>
            )}
          </div>
        </div>
        {/* Тумблер прижат к правому краю и выровнен по первой строке подписи, а не по
            центру блока: у настроек с длинным пояснением центр уезжает вниз, и ряд
            тумблеров переставал читаться колонкой. */}
        <Switch
          id={switchId}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
          className="mt-1"
        />
      </div>
      {checked && children && <div className="mt-4">{children}</div>}
    </div>
  )
}
