import { useState } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { toast } from 'sonner'

import { MAX_REDIRECT_URL_LEN, MAX_THANK_YOU_TEXT_LEN } from '@entities/formSchema'
import { MAX_CLOSED_MESSAGE_LEN, type FormDetail } from '../../../entities/form'
import { ApiError } from '../../../shared/api/errors'
import { PageFooter } from '../../../shared/page/PageFooter'
import { Section } from '../../../shared/page/Section'
import { ProTag } from '../../../shared/ProTag'
import { PlanUpsell } from '../../plan/PlanUpsell'
import { useFeatureAllowed } from '../../plan/useFeature'
import {
  useUpdateAfterSubmit,
  useUpdateBranding,
  useUpdateCloseSettings,
  useUpdateCollectPartial,
  useUpdateNotifyOnSubmission,
  useUpdateProgress,
} from '../queries'

import {
  isDirty,
  localInputToIso,
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
  const updateNotify = useUpdateNotifyOnSubmission()
  const updatePartial = useUpdateCollectPartial()
  const updateProgress = useUpdateProgress()
  const updateBranding = useUpdateBranding()

  // Гейты тарифа. Оба спрашиваются у снимка плана пространства, и оба ДЕРЖАТ САМ
  // КОНТРОЛ, а не отказывают после нажатия (тот же приём, что у бейджа на экране
  // «Встроить», EMBED §10): попытка включить платное на бесплатном тарифе ничего не
  // меняет и открывает разговор о тарифе. Направления разные — сбор незавершённых
  // гейтится на ВКЛЮЧЕНИИ, бейдж на СНЯТИИ.
  const canCollectPartial = useFeatureAllowed('submissions_partial')
  const canRemoveBadge = useFeatureAllowed('form_branding')
  const [upsell, setUpsell] = useState(false)

  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const invalid = validateSettings(draft)
  const anyInvalid = invalid.url || invalid.urlMissing || invalid.limit
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
        await updateClose.mutateAsync({
          id: form.id,
          settings: {
            closeAt: localInputToIso(draft.closeLocal),
            responseLimit: draft.limit.trim() === '' ? null : Number(draft.limit.trim()),
            closedMessage: draft.closedMessage,
          },
        })
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

      <Section
        title="Закрытие формы"
        description="Когда прекратить приём ответов. Закрытая форма показывает текст ниже вместо вопросов."
      >
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="close-at">
              Дата закрытия{' '}
              <span className="font-normal text-muted-foreground">(необязательно)</span>
            </Label>
            <Input
              id="close-at"
              type="datetime-local"
              value={draft.closeLocal}
              onChange={(e) => set('closeLocal', e.target.value)}
              className="mt-1.5"
            />
            <p className="mt-1.5 text-sm text-muted-foreground">
              После этого момента форма перестанет принимать ответы. Пусто — без ограничения по
              дате.
            </p>
          </div>

          <div>
            <Label htmlFor="response-limit">
              Лимит ответов{' '}
              <span className="font-normal text-muted-foreground">(необязательно)</span>
            </Label>
            <Input
              id="response-limit"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft.limit}
              placeholder="Например, 100"
              aria-invalid={invalid.limit}
              aria-describedby="response-limit-hint"
              onChange={(e) => set('limit', e.target.value)}
              className="mt-1.5"
            />
            <p
              id="response-limit-hint"
              className={`mt-1.5 text-sm ${invalid.limit ? 'text-destructive' : 'text-muted-foreground'}`}
              role={invalid.limit ? 'alert' : undefined}
            >
              {invalid.limit
                ? 'Лимит — целое число больше нуля.'
                : 'Форма закроется, набрав столько ответов. Пусто — без лимита.'}
            </p>
          </div>

          <div>
            <Label htmlFor="closed-message">
              Текст «приём закрыт»{' '}
              <span className="font-normal text-muted-foreground">(необязательно)</span>
            </Label>
            <Textarea
              id="closed-message"
              value={draft.closedMessage}
              placeholder="Приём ответов на эту форму закрыт."
              maxLength={MAX_CLOSED_MESSAGE_LEN}
              onChange={(e) => set('closedMessage', e.target.value)}
              className="mt-1.5"
            />
          </div>
        </div>
      </Section>

      <Section
        title="Уведомления"
        description="Письмо на вашу почту, когда на форму приходит новый ответ."
      >
        {/* Частые ответы склеиваются в одно письмо — троттлинг на бэкенде. */}
        <div className="flex items-center gap-3">
          <Switch
            id="notify-on-submission"
            checked={draft.notify}
            onCheckedChange={(v) => set('notify', v)}
          />
          <Label htmlFor="notify-on-submission" className="text-sm font-normal">
            Присылать письмо о новом ответе
          </Label>
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
            className={`text-sm ${failed || invalid.url || invalid.limit ? 'text-destructive' : 'text-muted-foreground'}`}
            role="status"
          >
            {invalid.url
              ? 'Проверьте ссылку перехода'
              : invalid.urlMissing
                ? 'Укажите ссылку перехода'
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
  children,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
  pro?: boolean
  children?: React.ReactNode
}) {
  const switchId = `${id}-switch`
  return (
    <div id={id} className="py-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Label htmlFor={switchId} className="text-base font-semibold">
              {label}
            </Label>
            {pro && <ProTag />}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {/* Тумблер прижат к правому краю и выровнен по первой строке подписи, а не по
            центру блока: у настроек с длинным пояснением центр уезжает вниз, и ряд
            тумблеров переставал читаться колонкой. */}
        <Switch id={switchId} checked={checked} onCheckedChange={onChange} className="mt-1" />
      </div>
      {checked && children && <div className="mt-4">{children}</div>}
    </div>
  )
}
