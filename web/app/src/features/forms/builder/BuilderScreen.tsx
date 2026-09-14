import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useStore } from 'zustand'
import { Link2, Plug, Redo2, Settings, Undo2 } from 'lucide-react'

import { showFormBadge } from '@fields/design'

import { displayFormName, type FormDetail } from '../../../entities/form'
import { useFeatureAllowed } from '../../plan/useFeature'
import { useWorkspaceCrumb } from '../../workspaces/crumb'
import { PageActions, PageCrumbs } from '../../../shared/page/headerPortals'
import { ChordChips } from './ChordChips'
import { DiscardChanges } from './DiscardChanges'
import { useEditorDrawers } from './editorDrawers'
import { DesignDrawer } from './DesignDrawer'
import { PreviewOverlay } from './PreviewOverlay'
import { PublishControls } from './PublishControls'
import { SaveIndicator, ConflictBanner } from './SaveIndicator'
import { SlashEditor } from './SlashEditor'
import { type FormIdSource } from './mediaUpload'
import { createFocusEngine } from './focusEngine'
import { createBuilderStore } from './store'
import { BuilderStoreContext } from './storeContext'
import { FormFactsProvider, type FormFacts } from './formFacts'
import { ChatDrawer } from '../chat/ChatDrawer'
import { useAutosave, type DraftCreation } from './useAutosave'
import { useGlobalChord } from './useGlobalChord'
import { chords, formatLabel, labelFor } from './shortcuts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Подпись значка с клавишами из карты шорткатов — той же, что читает шпаргалка Mod+/:
// строка «Ctrl+Z», написанная руками, врала бы на маке.
function withChord(text: string, match: Parameters<typeof labelFor>[0]): string {
  const chord = labelFor(match)
  return chord === undefined ? text : `${text} (${formatLabel(chord)})`
}

// Значок бара: подсказка обязательна, и текст у неё общий с aria-label — одна строка
// на оба (DESIGN-SYSTEM §7, образец — RowAction в IntegrationsView).
function BarIcon({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  // ⚠ У выключенной кнопки нет pointer-событий, и тултип на ней не открылся бы —
  // обёртка-span держит наведение (тот же приём, что у PublishButton).
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            disabled={disabled}
            onClick={onClick}
            aria-label={label}
          >
            <Icon className="size-4" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

const undoLabel = withChord('Отменить', chords.undo)
const redoLabel = withChord('Повторить', chords.redo)

// Режимов у редактора больше нет: полотно — единственное, что он показывает.
// Настройки уехали в раздел формы (`/forms/{slug}/settings`, решение владельца
// 2026-08-26, отменяет прежнее «ссылки на настройки нет»), просмотр наезжает на окно
// отдельным слоем (`PreviewOverlay`), оформление — шторкой сбоку.

// BuilderScreen — редактор в стиле Tally: чистое документное полотно (SlashEditor),
// а все элементы управления (статус сохранения, просмотр, публикация) порталятся в
// верхнюю шапку приложения — в один бар с кнопкой сворачивания сайдбара.
// Стор создаётся один раз на инстанс и сразу гидрируется черновиком; маршрут
// монтирует экран с key={formId}, поэтому переход на другую форму даёт свежий стор.
//
// draft задан, пока формы НЕТ на сервере (ленивое создание, features/forms/draft.ts):
// detail тогда синтетическая, detail.id пуст, и всё, что адресует форму по id,
// спрашивает ensureForm — она заводит форму по первой надобности.
export function BuilderScreen({ detail, draft }: { detail: FormDetail; draft?: DraftCreation }) {
  // Бейдж решается ЗДЕСЬ, а не в превью: экран уже живёт внутри провайдера Query и
  // уже ходит в чужие фичи, а превью остаётся чистым видом стора — иначе провайдер
  // потребовался бы каждому, кто его рисует, включая тесты раскладки. Намерение
  // автора — живое свойство формы (detail.branding), тумблер его правит на экране
  // вставки, и перепубликации оно не ждёт (ADR §10).
  const canRemoveBadge = useFeatureAllowed('form_branding')
  const badge = showFormBadge(detail.branding, canRemoveBadge)
  const [store] = useState(() => {
    const s = createBuilderStore()
    s.getState().hydrate(detail.draftSchema)
    return s
  })

  // Фокус-движок полотна живёт здесь (а не в SlashEditor): он обязан пережить
  // переключение режима edit↔preview (SlashEditor размонтируется) и, главное, дать
  // undo/redo поставить каретку на затронутый блок (§2.4) — отмену дёргает этот
  // экран (клавиатура + кнопки), а не полотно. SlashEditor раздаёт его через контекст.
  const [engine] = useState(() => createFocusEngine())

  const workspaceCrumb = useWorkspaceCrumb()
  const { status, saveNow, ensureForm } = useAutosave(
    store,
    detail.id,
    detail.slug,
    detail.updatedAt,
    draft,
  )
  // Куда грузить картинки. Пока формы нет, вниз уходит не id, а обещание его добыть:
  // обложку автор вправе выбрать первым же действием, раньше любой правки полотна, —
  // и тогда форму заводит она (mediaUpload.FormIdSource).
  const uploadTo: FormIdSource = detail.id || (() => ensureForm().then((f) => f.id))
  const [previewOpen, setPreviewOpen] = useState(false)
  const navigate = useNavigate()
  // Оформление — НЕ режим, а шторка поверх полотна: автор смотрит на форму, а не на
  // панель, и тема обязана меняться у него на глазах. Режим (как у настроек) закрыл
  // бы полотно и превратил подбор темы в угадывание. Шторка ассистента (фаза 26)
  // устроена так же и делит с ней одно место у правого края — отсюда общее состояние.
  const drawers = useEditorDrawers()
  // Клавиши на кнопке помощи — из карты шорткатов, а не строкой рядом с ней: подпись
  // на кнопке и обещание шпаргалки обязаны совпадать.
  const chatChord = labelFor(chords.openChat)

  // Отмена/повтор + каретка на первый затронутый откатом блок (§2.4). id приходит из
  // стора; блок мог ещё не смонтироваться (только что восстановлен) — движок поставит
  // фокус, как только строка зарегистрирует цель (pending в focusEngine).
  const undo = () => {
    const id = store.getState().undo()
    if (id) engine.focusBlock(id)
  }
  const redo = () => {
    const id = store.getState().redo()
    if (id) engine.focusBlock(id)
  }

  // Публиковать можно только когда серверный черновик догнал редактор: нет
  // несохранённых правок и последний автосейв успешен (иначе снапшот будет старым).
  const dirty = useStore(store, (s) => s.dirty)
  const canPublish = status === 'saved' && !dirty

  const everPublished = detail.publishedVersion !== null
  const canUndo = useStore(store, (s) => s.past.length > 0)
  const canRedo = useStore(store, (s) => s.future.length > 0)

  // Горячие клавиши истории на весь экран билдера: Ctrl/Cmd+Z — отмена,
  // Ctrl/Cmd+Shift+Z и Ctrl+Y — повтор. Слушатель живёт вместе с экраном; на
  // документ-уровне перехватываем и внутри textarea полотна (нативный undo поля
  // уступает отмене всего документа — так ведёт себя Notion/Tally). Пустой стек —
  // no-op. Исключение одно и его держит useGlobalChord: поле во всплывающем слое
  // (настройки блока, поиск типа) правит СЕБЯ, а не документ.
  useGlobalChord((e) => {
    // Матчеры по e.code (§3.1, shortcuts.ts): при кириллической (и любой не-латинской)
    // раскладке Ctrl+Z даёт e.key='я', и хоткей молча ломался — срабатывал нативный
    // undo контролируемого textarea (откат по одному символу).
    // Alt+J — шторка помощи ИИ. Здесь же, где история: жест документ-уровня, работает
    // из любой строки полотна. preventDefault обязателен — на маке Option+J печатает
    // символ, и без него он уехал бы в текст блока вместе с открытием шторки.
    if (chords.openChat(e)) {
      e.preventDefault()
      // ТОГЛ, как у шпаргалки Mod+/: жест, которым шторку открыли, обязан её и
      // закрывать — иначе руку с клавиатуры приходится снимать ради крестика.
      drawers.openChat(!drawers.chatOpen)
      return
    }
    const isUndo = chords.undo(e)
    const isRedo = chords.redo(e)
    if (!isUndo && !isRedo) return
    e.preventDefault()
    if (isUndo) undo()
    else redo()
  })

  // Факты формы, которых нет в схеме: id (может быть обещанием — черновика ещё нет),
  // пространство и выбранное расписание записи. Попап блока «Запись» берёт их отсюда:
  // тащить три поля пропами через строку до попапа значило бы расширить контракт всем
  // типам ради одного.
  const formFacts: FormFacts = {
    id: uploadTo,
    workspaceId: detail.workspaceId,
    workspaceSlug: detail.workspaceSlug,
    scheduleId: detail.scheduleId,
  }

  return (
    <BuilderStoreContext.Provider value={store}>
      <FormFactsProvider value={formFacts}>
      <PageCrumbs items={[workspaceCrumb, displayFormName(detail)]} />
      {/* Кнопки редактора — в правую половину верхнего бара. */}
      <PageActions>
        {/* Статус — первым в ряду, перед историей (решение владельца 2026-09-14): у
            публиковавшейся формы — плашка «Есть изменения» с откатом, у ни разу не
            публиковавшейся — бейдж «Черновик». Условие отката — то же, что у
            публикации: черновик догнал редактор, иначе откат гонится с автосейвом за
            один токен блокировки. */}
        {everPublished ? (
          <DiscardChanges form={detail} canDiscard={canPublish} />
        ) : (
          <Badge variant="secondary">Черновик</Badge>
        )}
        {/* Отмена/повтор — история документа, ближе всего к полотну,
            которое они правят. Пара значков стоит своей коробкой без gap
            (DESIGN-SYSTEM §7): поля ghost-кнопок уже дают воздух между ними. */}
        <div className="flex items-center">
          <BarIcon icon={Undo2} label={undoLabel} disabled={!canUndo} onClick={undo} />
          <BarIcon icon={Redo2} label={redoLabel} disabled={!canRedo} onClick={redo} />
        </div>
        {/* Разделы формы — значками ПЕРЕД просмотром, в порядке табов формы: ссылка,
            интеграции, настройки (решение владельца 2026-09-14). Ссылка и интеграции —
            только у публиковавшейся формы: у черновика нет ни публичной страницы, ни
            ответов, которые можно доставлять. Коробка без gap, как у истории.

            Настройки — УХОД из редактора в раздел формы, а не режим внутри него. У
            НЕСОЗДАННОЙ формы адреса ещё нет (ленивое создание, features/forms/draft.ts),
            поэтому клик её заводит: настройки живут по настоящему slug'у, и вести туда
            `new` некуда. */}
        <div className="flex items-center">
          {everPublished && (
            <>
              <BarIcon
                icon={Link2}
                label="Ссылка на форму"
                onClick={() =>
                  void navigate({ to: '/forms/$slug/share', params: { slug: detail.slug } })
                }
              />
              <BarIcon
                icon={Plug}
                label="Интеграции"
                onClick={() =>
                  void navigate({ to: '/forms/$slug/integrations', params: { slug: detail.slug } })
                }
              />
            </>
          )}
          <BarIcon
            icon={Settings}
            label="Настройки формы"
            onClick={() => {
              void ensureForm()
                .then(({ slug }) => navigate({ to: '/forms/$slug/settings', params: { slug } }))
                .catch(() => undefined)
            }}
          />
        </div>
        {/* Просмотр — только ВХОД, не тумблер: слой закрывает шапку целиком,
            и кнопки, которой можно было бы нажать второй раз, под ним нет.
            Выход подписан словами на самом слое. */}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setPreviewOpen(true)}
        >
          Просмотр
        </Button>
        {/* Оформление — ТУМБЛЕР шторки, а не вход в режим (в отличие от
            настроек ниже): она выезжает сбоку, ОТОДВИГАЯ оболочку, а не
            закрывая полотно, и второго выхода мимо чего-либо тут нет —
            закрывать нечему. Отдельно от настроек ещё и потому, что
            сохраняется иначе: тема применяется сразу и уезжает автосейвом,
            настройки — явной кнопкой. «Просмотр» и «Оформление» — словами без
            значков (решение владельца 2026-09-14). */}
        <Button
          variant="ghost"
          size="sm"
          className={drawers.designOpen ? undefined : 'text-muted-foreground'}
          aria-pressed={drawers.designOpen}
          onClick={() => drawers.openDesign(!drawers.designOpen)}
        >
          Оформление
        </Button>
        {/* Статус автосейва стоит у самой публикации: именно он решает,
            активна ли кнопка «Опубликовать» (canPublish). */}
        <SaveIndicator status={status} onRetry={saveNow} />
        <PublishControls form={detail} canPublish={canPublish} ensureForm={ensureForm} />
      </PageActions>

      {status === 'conflict' && <ConflictBanner />}

      <SlashEditor
        formId={uploadTo}
        engine={engine}
        onOpenDesign={() => drawers.openDesign(true)}
        onOpenChat={() => drawers.openChat(true)}
      />
      {/* Кнопка ассистента — в правом нижнем углу (решение владельца 2026-09-01).
          Позиция fixed, а не absolute: полотно длинное и прокручивается, а вход в
          разговор обязан быть под рукой на любой его высоте. Угол свободен —
          кластеры значков строки и рейлы групп живут внутри колонки. */}
      {/* Кнопка СТОИТ НА МЕСТЕ и при открытой шторке (решение владельца 2026-09-02):
          она fixed, привязана к окну, и открытая панель её накрывает. Вход в разговор
          при этом не теряется — разговор уже открыт, а закрывают его тем же Alt+J,
          крестиком шторки или Esc.

          БЕЛАЯ (`outline`), а не акцентная: акцентом в кабинете покрашено главное действие
          экрана, а главное здесь — «Опубликовать» в верхнем баре, и две акцентные кнопки
          спорили бы за внимание. Значка нет по той же причине — надпись называет
          действие, а глиф добавлял бы к ней вес.

          КЛАВИШИ НАПЕЧАТАНЫ НА КНОПКЕ и берутся из карты (`SHORTCUTS`), а не пишутся
          рядом второй раз: подпись на кнопке и обещание шпаргалки Mod+/ обязаны
          совпадать, а совпадают они только у общего источника. */}
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="fixed right-6 bottom-6 z-30 gap-2 rounded-lg px-4 shadow-lg"
        onClick={() => drawers.openChat(true)}
      >
        Помощь ИИ
        {chatChord !== undefined && <ChordChips label={chatChord} />}
      </Button>
      <ChatDrawer
        open={drawers.chatOpen}
        onOpenChange={drawers.openChat}
        formId={detail.id}
        ensureFormId={() => ensureForm().then((f) => f.id)}
      />
      {/* Просмотр — слой поверх окна (PreviewOverlay), а внутри слоя — СВОЙ документ
          (TD-60): свой CSS автора обязан быть здесь виден и обязан не покидать фрейм,
          иначе `.rf-input{display:none}` из формы погасил бы поля самого кабинета.
          Стор передаётся пропом — контекст через границу корней React не проходит
          (PreviewFrame.tsx). Закрытым слой ничего не монтирует (Radix не рисует
          содержимое), поэтому держать его здесь всегда дёшево — и только так Radix
          успевает проиграть закрытие. */}
      <PreviewOverlay
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        store={store}
        title={detail.title}
        badge={badge}
        progress={detail.progress}
        allowBack={detail.allowBack}
      />
      {/* Шторка остаётся смонтированной и в закрытом виде — иначе Radix не успевает
          проиграть закрытие, панель исчезает мгновенно, а оболочка едет назад 300 мс,
          и видно, что это два разных элемента. Урок фазы 21 («закрытые диалоги не
          монтировать») тут не работает против нас: он про диалоги, подписанные на
          s.blocks и потому перерисовывающиеся на каждый символ, а эта панель
          подписана на s.design — он при вводе не меняется. */}
      <DesignDrawer formId={uploadTo} open={drawers.designOpen} onOpenChange={drawers.openDesign} />
      </FormFactsProvider>
    </BuilderStoreContext.Provider>
  )
}

// Breadcrumbs — путь над редактором: Дом (дашборд форм) → пространство → форма.
// Имя воркспейса — серверный стейт из Query (в MVP один личный); пока не
// подгрузилось, крошка пространства не рисуется, чтобы не мигать пустотой.
// Пространство и текущая форма — не ссылки: страницы пространства пока нет, а
// форма — текущая. Длинные имена усекаются, шапку не распирают.
