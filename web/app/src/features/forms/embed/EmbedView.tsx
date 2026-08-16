import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Code2, Eye, X } from 'lucide-react'

import { type FormDetail } from '../../../entities/form'
import {
  DEFAULT_BLOCK_HEIGHT,
  DEFAULT_OPEN_DELAY,
  DEFAULT_WIDGET_EMOJI,
  DEFAULT_WIDGET_WIDTH,
  iframeSnippet,
  scriptSnippet,
  type EmbedMode,
  type SnippetOptions,
} from '../embedSnippet'
import { publicFormUrl } from '../publicUrl'
import { CodePanel } from './CodePanel'
import { MockSite } from './MockSite'
import { SettingsPanel, type EmbedSettings } from './SettingsPanel'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'

// Экран «Встроить» (/forms/{slug}/embed): слева настройки вставки, справа —
// страница-макет, в которой форма живёт ТЕМ ЖЕ кодом, что уезжает автору в буфер
// обмена. Вид вставки приходит из адреса (три кнопки на «Поделиться» ведут сюда
// каждая на свой), остальные настройки — локальное состояние: они нигде не
// сохраняются и живут в самом сниппете (ADR §10).

export function EmbedView({
  form,
  mode,
  onModeChange,
  onClose,
}: {
  form: FormDetail
  mode: EmbedMode
  onModeChange: (mode: EmbedMode) => void
  /** Выход с экрана — обратно на «Поделиться», откуда сюда и приходят. */
  onClose: () => void
}) {
  const [settings, setSettings] = useState<EmbedSettings>({
    label: 'Оставить заявку',
    position: 'bottom-right',
    transparent: false,
    hideTitle: false,
    alignLeft: false,
    height: DEFAULT_BLOCK_HEIGHT,
    dynamicHeight: true,
    width: DEFAULT_WIDGET_WIDTH,
    // Затемнения по умолчанию НЕТ: панель в углу — продолжение кнопки, а не перехват
    // страницы, и потемневший сайт вокруг неё противоречит самому жесту.
    overlay: false,
    open: 'click',
    openValue: DEFAULT_OPEN_DELAY,
    emoji: DEFAULT_WIDGET_EMOJI,
    emojiWave: false,
    hideOnSubmit: false,
    plain: false,
  })
  const [showCode, setShowCode] = useState(false)

  const change = (patch: Partial<EmbedSettings>) =>
    setSettings((prev) => ({ ...prev, ...patch }))

  // База — та же, что у публичной ссылки: сниппет и ссылка обязаны вести в одно место.
  const baseUrl = publicFormUrl(form.slug).replace(`/r/${form.slug}`, '')
  const opts: SnippetOptions = {
    baseUrl,
    slug: form.slug,
    mode,
    label: settings.label,
    position: settings.position,
    transparent: settings.transparent,
    hideTitle: settings.hideTitle,
    alignLeft: settings.alignLeft,
    height: settings.height,
    dynamicHeight: settings.dynamicHeight,
    width: settings.width,
    overlay: settings.overlay,
    open: settings.open,
    openValue: settings.openValue,
    emoji: settings.emoji,
    emojiWave: settings.emojiWave,
    hideOnSubmit: settings.hideOnSubmit,
  }
  const usePlain = settings.plain && mode !== 'widget'
  const snippet = usePlain ? iframeSnippet(opts) : scriptSnippet(opts)
  // В макет уезжает тот же сниппет плюс флаг предпросмотра — единственное отличие
  // исполняемого кода от показанного (MockSite).
  const previewOpts: SnippetOptions = { ...opts, preview: true }
  const previewSnippet = usePlain ? iframeSnippet(previewOpts) : scriptSnippet(previewOpts)

  return (
    // ЭКРАН ПОВЕРХ КАБИНЕТА, а не область внутри него, — тем же слоем и по тому же
    // доводу, что просмотр формы (PreviewOverlay, решение владельца 2026-08-15):
    // макет изображает ЧУЖУЮ страницу, и наши сайдбар с шапкой вокруг него сделали бы
    // сцену неправдой. Radix даёт ловушку фокуса, замок скролла и Esc даром.
    <Sheet open onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="full"
        showCloseButton={false}
        aria-describedby={undefined}
        className="gap-0 overflow-hidden p-0"
      >
        <SheetTitle className="sr-only">Встроить форму на сайт</SheetTitle>
        <ScrollbarGutterOff />
        <div className="flex h-dvh flex-col">
          <header className="flex items-center justify-between border-b px-5 py-3">
            <div>
              <h1 className="text-base font-medium">Встроить на сайт</h1>
              {/* Неопубликованная форма во фрейме отдаёт 404 (инвариант 5: черновик
                  неотличим от несуществующей), и в макете это выглядит как поломка
                  вставки. Говорим до того, как автор пойдёт искать причину в коде. */}
              {form.publishedVersion === null ? (
                <p className="text-xs text-muted-foreground">
                  Форма ещё не опубликована — в макете она недоступна, как была бы и на вашем
                  сайте. Код ниже можно скопировать уже сейчас.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Форма в макете настоящая: заполняется и проверяет поля, но ответ из предпросмотра
                  не отправляется.
                </p>
              )}
            </div>
            <Button asChild variant="ghost" size="sm" className="gap-1.5">
              <Link to="/forms/$slug/share" params={{ slug: form.slug }} search={(prev) => prev}>
                <X className="size-4" /> Закрыть
              </Link>
            </Button>
          </header>

          <div className="flex min-h-0 flex-1">
            <aside className="w-80 shrink-0 overflow-y-auto border-r p-5">
              <Button
                className="mb-5 w-full gap-1.5"
                variant={showCode ? 'outline' : 'default'}
                onClick={() => setShowCode((v) => !v)}
              >
                {showCode ? (
                  <>
                    <Eye className="size-4" /> Вернуться к предпросмотру
                  </>
                ) : (
                  <>
                    <Code2 className="size-4" /> Получить код
                  </>
                )}
              </Button>
              <SettingsPanel
                form={form}
                mode={mode}
                onModeChange={onModeChange}
                settings={settings}
                onChange={change}
              />
            </aside>

            <main className="min-w-0 flex-1 overflow-y-auto bg-muted/30">
              {showCode ? (
                <div className="mx-auto max-w-3xl p-6">
                  <CodePanel form={form} opts={opts} snippet={snippet} />
                </div>
              ) : (
                // МАКЕТ ПЕРЕСОБИРАЕТСЯ ЦЕЛИКОМ на смену любой настройки: ключ — сам
                // сниппет. Это не оптимизационная лень, а правда о вставке: на чужом
                // сайте настройки меняются переписыванием кода и перезагрузкой
                // страницы, промежуточного состояния «фрейм тот же, атрибуты другие»
                // не бывает.
                <PreviewArea snippet={previewSnippet} />
              )}
            </main>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ЖЁЛОБ ПОЛОСЫ ПРОКРУТКИ КАБИНЕТА НА ВРЕМЯ ЭКРАНА СНИМАЕТСЯ — та же починка, что у
// просмотра формы (PreviewOverlay, там же почему): `html` держит
// `scrollbar-gutter: stable`, и накрыть его слоем нельзя, поэтому рядом с полосой
// макета видно вторую, пустую.
function ScrollbarGutterOff() {
  useEffect(() => {
    document.documentElement.dataset.previewOpen = ''
    return () => {
      delete document.documentElement.dataset.previewOpen
    }
  }, [])
  return null
}

// PreviewArea — макет с задержкой пересборки: надпись на кнопке виджета вводится
// посимвольно, и без паузы каждый символ перезагружал бы страницу-макет вместе с
// формой в ней.
function PreviewArea({ snippet }: { snippet: string }) {
  const [applied, setApplied] = useState(snippet)
  useEffect(() => {
    const timer = setTimeout(() => setApplied(snippet), 350)
    return () => clearTimeout(timer)
  }, [snippet])

  return (
    <div className="h-full p-4">
      <div className="h-full overflow-hidden rounded-lg border bg-white shadow-sm">
        <MockSite snippet={applied} />
      </div>
    </div>
  )
}
