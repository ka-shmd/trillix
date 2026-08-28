import { useEffect, useState } from 'react'
import { Code2, Eye, TriangleAlert, X } from 'lucide-react'

import { type FormDetail } from '../../../entities/form'
import {
  DEFAULT_BLOCK_HEIGHT,
  DEFAULT_OPEN_DELAY,
  DEFAULT_WIDGET_WIDTH,
  frameUrl,
  iframeSnippet,
  scriptSnippet,
  type EmbedMode,
  type SnippetOptions,
} from '../embedSnippet'
import { publicFormUrl } from '../publicUrl'
import { CodePanel, CopyButton } from './CodePanel'
import { MockSite } from './MockSite'
import { ModeChoice } from './ModeChoice'
import { SettingsPanel, type EmbedSettings } from './SettingsPanel'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet'

// Экран «Встроить» (/forms/{slug}/embed) — ОТДЕЛЬНЫЙ РЕЖИМ, а не страница кабинета
// (решение владельца 2026-08-27). Две области и ничего сверх: слева настройки
// вставки, справа страница-макет, в которой форма живёт ТЕМ ЖЕ кодом, что уезжает
// автору в буфер обмена. Ни крошек, ни шапки с заголовком: кабинет вокруг сцены,
// изображающей чужой сайт, делал бы сцену неправдой.
//
// Вид вставки приходит из адреса (три кнопки на «Поделиться» ведут сюда каждая на
// свой), остальные настройки — локальное состояние: они нигде не сохраняются и живут
// в самом сниппете (ADR §10).

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
    // Прозрачный фон — с самого начала (решение владельца 2026-08-27): вставка на
    // чужой странице должна выглядеть её частью, а белый прямоугольник поверх чужого
    // фона выдаёт её первым же кадром. Умолчание ПАНЕЛИ, не загрузчика: у того фон
    // остаётся непрозрачным — контракт `v1.js` бессрочный (EMBED.md §2).
    transparent: true,
    // Оба включены по умолчанию (решение владельца 2026-08-16): над вставкой на чужой
    // странице почти всегда есть свой заголовок, а блок читается как часть страницы,
    // когда начинается от её левого края, а не по центру своей колонки.
    hideTitle: true,
    alignLeft: true,
    height: DEFAULT_BLOCK_HEIGHT,
    dynamicHeight: true,
    width: DEFAULT_WIDGET_WIDTH,
    // Затемнения по умолчанию НЕТ: панель в углу — продолжение кнопки, а не перехват
    // страницы, и потемневший сайт вокруг неё противоречит самому жесту.
    overlay: false,
    open: 'click',
    openValue: DEFAULT_OPEN_DELAY,
    hideOnSubmit: false,
    plain: false,
  })
  const [showCode, setShowCode] = useState(false)

  const change = (patch: Partial<EmbedSettings>) => setSettings((prev) => ({ ...prev, ...patch }))

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
        {/* Заголовка на экране нет — режим объясняет себя двумя своими областями, — но
            слою имя нужно: без него Radix ругается, а скринридер не назовёт, куда
            человек попал. */}
        <SheetTitle className="sr-only">Встроить форму на сайт</SheetTitle>
        <ScrollbarGutterOff />
        <div className="flex h-dvh">
          {/* КОЛОНКА — ДВА РАЗДЕЛА (решение владельца 2026-08-27): «Встраивание» —
              что вставляем и чем это забрать (вид, код, ссылка), «Опции» — как оно
              выглядит. Разница между ними не в важности, а в природе: первый раздел
              одинаков у всех трёх видов, второй у каждого свой.
              Рамки справа нет: колонка белая, страница-макет серая — границу рисует
              сама разница поверхностей, и линия поверх неё была бы вторым забором. */}
          <aside className="flex w-125 shrink-0 flex-col overflow-y-auto px-12.5 py-5">
            <section className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-3xl font-extrabold tracking-tight">Встраивание</h2>
                {/* Выход из режима. Крестовина без подписи — жест закрытия читается
                    сам, а место рядом с заголовком не оставляет сомнений, что
                    закрывается экран, а не макет. */}
                <SheetClose asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="-mr-2 text-muted-foreground"
                    aria-label="Закрыть"
                    title="Закрыть"
                  >
                    <X className="size-4" />
                  </Button>
                </SheetClose>
              </div>
              <ModeChoice form={form} mode={mode} onModeChange={onModeChange} />
              <div className="flex flex-col gap-2">
                {/* Код — тумблер, а не вход: макет и код делят одну область, и
                    вернуться нужно тем же жестом. */}
                <Button
                  className="w-full gap-1.5"
                  // Чёрная, а не синяя: синий в кабинете значит «главное действие
                  // экрана», а главное здесь — сама вставка, которую автор
                  // настраивает; код это то, чем её забирают (DESIGN-SYSTEM §«цвет»).
                  variant={showCode ? 'outline' : 'utility'}
                  size="sm"
                  aria-pressed={showCode}
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
                {/* Ссылка на фрейм — второй способ забрать вставку, для редакторов,
                    которые делают фрейм сами (Notion, Ghost, Canva). Она же есть
                    внутри кода отдельным разделом; здесь — потому что за ней
                    приходят так же часто, как за кодом, и открывать ради неё экран
                    кода незачем. */}
                <CopyButton
                  text={frameUrl(opts)}
                  label="Скопировать ссылку встраивания"
                  variant="ghost"
                  className="w-full"
                />
              </div>
            </section>

            <Separator className="my-6" />

            <section className="flex flex-col gap-4">
              <h2 className="text-3xl font-extrabold tracking-tight">Опции</h2>
              <SettingsPanel form={form} mode={mode} settings={settings} onChange={change} />
            </section>
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
              <PreviewArea form={form} snippet={previewSnippet} />
            )}
          </main>
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
//
// МАКЕТ ЗАНИМАЕТ ВСЮ ОБЛАСТЬ — без карточки, рамки и полей вокруг (решение владельца
// 2026-08-27): рамка превращала чужую страницу в картинку на нашей, а она и есть
// вторая половина экрана. Подписи под ней тоже нет — сцена объясняет себя сама.
//
// Единственное, что над макетом появляется, — предупреждение о неопубликованной
// форме, и только оно: во фрейме такая форма отдаёт 404 (инвариант 5: черновик
// неотличим от несуществующей), то есть выглядит как поломка вставки. Говорим до
// того, как автор пойдёт искать причину в своём коде.
function PreviewArea({ form, snippet }: { form: FormDetail; snippet: string }) {
  const [applied, setApplied] = useState(snippet)
  useEffect(() => {
    const timer = setTimeout(() => setApplied(snippet), 350)
    return () => clearTimeout(timer)
  }, [snippet])

  return (
    <div className="flex h-full flex-col">
      {form.publishedVersion === null && (
        <p className="flex items-start gap-1.5 bg-warning/10 px-4 py-2 text-xs text-muted-foreground">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            Форма ещё не опубликована — в макете она недоступна, как была бы и на вашем сайте. Код
            можно скопировать уже сейчас.
          </span>
        </p>
      )}
      <div className="min-h-0 flex-1">
        <MockSite snippet={applied} />
      </div>
    </div>
  )
}
