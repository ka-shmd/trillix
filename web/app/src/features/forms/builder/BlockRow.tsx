import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Asterisk, GripVertical, Plus, Trash2, X } from 'lucide-react'
import {
  type Block,
  carriesText,
  isCaptionType,
  isChoiceType,
  isContentType,
  SCALE_LOWER_BOUND,
  SCALE_UPPER_BOUND,
  scaleRange,
  supportsPlaceholder,
} from '@entities/formSchema'
import { BlockControl } from '@fields/BlockField'
import { optionKey } from '@fields/answer'
import { type MenuItem } from './blockTypes'
import { noLayoutAnimation } from './dnd'
import { typeIcons } from './blockTypeIcons'
import { useBuilderStore } from './storeContext'
import { SlashMenu } from './SlashMenu'
import { ImageField } from './ImageField'

// Автовысота textarea: строка вопроса растёт под контент, не заводя скролл.
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

export interface BlockRowProps {
  block: Block
  // formId нужен image-блоку для загрузки картинки (POST /forms/{id}/media).
  formId: string
  // groupHandle — attributes+listeners sortable-элемента ГРУППЫ (внешний уровень
  // dnd): грип этой строки тащит всю группу, а не сам блок. Ставится родителем
  // только на подпись мульти-группы («подпись владеет группой»). null/undefined —
  // грип тащит блок (блочный слой dnd: одиночки и внутренние строки).
  groupHandle?: Pick<ReturnType<typeof useSortable>, 'attributes' | 'listeners'> | null
  // focusMe — редактор просит поставить фокус на label этой строки (после Enter/
  // удаления соседа/навигации стрелками). onFocusHandled сбрасывает запрос.
  focusMe: boolean
  onFocusHandled: () => void
  // openMenuOnMount — строку создали по «/» или «+»: сразу открыть меню выбора типа.
  openMenuOnMount: boolean
  // onAddBelow — Enter: новая текстовая строка без меню (продолжаем писать).
  onAddBelow: (id: string) => void
  // onInsertBelow — кнопка «+»: новая строка с открытым меню выбора типа.
  onInsertBelow: (id: string) => void
  // onBackspaceAtStart — Backspace в начале блока: удалить картинку-соседа сверху или
  // схлопнуть пустой блок в предыдущий (решает родитель — знает соседей).
  onBackspaceAtStart: (id: string) => void
  onArrow: (id: string, dir: 'up' | 'down') => void
}

// BlockRow — одна строка полотна в стиле Tally: слева в поле — ручка перетаскивания
// (dnd) и «+», по центру редактируемый заголовок и живое превью поля, справа —
// меню действий и удаление. Клавиатура: Enter — новый блок, «/» — меню типов,
// Backspace в пустом — удалить и уйти на предыдущий, ↑/↓ на границе — переход,
// Alt+↑/↓ — перемещение.
export function BlockRow({
  block,
  formId,
  groupHandle,
  focusMe,
  onFocusHandled,
  openMenuOnMount,
  onAddBelow,
  onInsertBelow,
  onBackspaceAtStart,
  onArrow,
}: BlockRowProps) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const moveBlock = useBuilderStore((s) => s.moveBlock)
  const removeBlock = useBuilderStore((s) => s.removeBlock)
  const removeGroup = useBuilderStore((s) => s.removeGroup)
  const changeBlockType = useBuilderStore((s) => s.changeBlockType)
  const makeQuestion = useBuilderStore((s) => s.makeQuestion)
  const makeField = useBuilderStore((s) => s.makeField)
  const labelRef = useRef<HTMLTextAreaElement>(null)
  // Строку создали по «/» → меню типов открыто с монтирования (без setState в эффекте).
  const [slashOpen, setSlashOpen] = useState(openMenuOnMount)
  // Описание вопроса: раскрыто ли поле. Непустое описание раскрыто с монтирования.
  // Триггер раскрытия живёт в левом кластере значков (absolute) — см. коммент там.
  // Плейсхолдер заголовка виден только у активной (в фокусе) строки: неактивный
  // пустой блок ничего не показывает.
  const [labelFocused, setLabelFocused] = useState(false)
  const captionPh =
    block.type === 'title'
      ? 'Заголовок вопроса'
      : block.type === 'label'
        ? 'Подпись поля'
        : block.type === 'heading'
          ? 'Заголовок раздела'
          : block.type === 'consent'
            ? 'Текст согласия'
            : labelFocused
              ? 'Текст, или «/» для поля'
              : undefined
  const isContent = isContentType(block.type)
  const isImage = block.type === 'image'
  // Согласие правится строкой заголовка (текст согласия = label), поэтому у него
  // нет отдельного превью-контрола: галочка стоит слева от самого текста.
  const isConsent = block.type === 'consent'
  // hasTextLine — у блока есть редактируемая строка текста: подписи/контент и
  // consent. Поля ввода строки не несут — их подпись живёт отдельным блоком.
  const hasTextLine = carriesText(block.type)
  const captionCls =
    block.type === 'title'
      ? 'rf-label placeholder:font-semibold'
      : block.type === 'label'
        ? 'rf-label rf-label--sm placeholder:font-medium'
        : block.type === 'heading'
          ? 'rf-heading placeholder:font-semibold'
          : block.type === 'consent'
            ? 'rf-consent placeholder:font-normal'
            : 'rf-text placeholder:font-normal'

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    // Без «доигрывания» анимации после дропа (отскок к старой позиции) — см. dnd.ts.
    // У строк артефакт проявлялся при переносе ВНУТРИ группы (без ремаунта).
    animateLayoutChanges: noLayoutAnimation,
  })
  // Translate, а не Transform: блоки разной высоты, и dnd-kit кладёт в transform
  // scaleY, чтобы переносимый блок «подгонялся» под высоту соседнего слота — из-за
  // этого он визуально сжимался/растягивался при перетаскивании. Translate.toString
  // берёт только сдвиг (translate3d), scaleX/scaleY отбрасывает — блок сохраняет
  // свою высоту. Смещение соседей (scale=1) от этого не страдает.
  const style = { transform: CSS.Translate.toString(transform), transition }

  useEffect(() => {
    if (!focusMe) return
    focusLabelEnd()
    onFocusHandled()
  }, [focusMe, onFocusHandled])

  useEffect(() => {
    autosize(labelRef.current)
  }, [block.text])

  function focusLabelEnd() {
    const el = labelRef.current
    if (!el) return
    el.focus()
    const len = el.value.length
    el.setSelectionRange(len, len)
  }

  function onLabelKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget
    if (e.key === 'Enter') {
      e.preventDefault()
      onAddBelow(block.id)
    } else if (e.key === '/' && isContent) {
      // «/» открывает меню типов у неотвечаемого (text) блока — в т.ч. когда текст
      // уже набран: он станет подписью выбранного поля (changeBlockType сохраняет
      // label), как «напиши вопрос → «/» → выбери тип» в Tally. У блока с уже
      // выбранным типом «/» не работает — смена типа запрещена. Компромисс:
      // литеральный «/» в text-абзаце с клавиатуры не ввести (всегда команда).
      e.preventDefault()
      setSlashOpen(true)
    } else if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
      // Каретка схлопнута в начале блока. Решение принимает родитель (знает соседей):
      // предыдущий блок — картинка → удалить её (как Backspace перед элементом в
      // текстовом документе), иначе пустой текущий блок схлопнуть в предыдущий. Дефолт
      // гасим всегда — нативный Backspace в начале блока и так ничего не делает.
      e.preventDefault()
      onBackspaceAtStart(block.id)
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      moveBlock(block.id, e.key === 'ArrowUp' ? 'up' : 'down')
    } else if (e.key === 'ArrowUp' && el.selectionStart === 0) {
      e.preventDefault()
      onArrow(block.id, 'up')
    } else if (e.key === 'ArrowDown' && el.selectionStart === el.value.length) {
      e.preventDefault()
      onArrow(block.id, 'down')
    }
  }

  // Раскрыть поле описания и поставить в него каретку (rAF — textarea появляется
  // только на следующий рендер). Уже раскрытое просто фокусируем.

  function pickType(item: MenuItem) {
    // «Вопросы» → бандл подпись+поле; «Отдельные поля» → голое поле; и то, и другое
    // одиночный блок конвертирует на месте, а внутри группы — новой группой ниже
    // (инпут не встраивается между подписью и контролом). «Лэйаут» → тип на месте.
    if (item.group === 'question') makeQuestion(block.id, item.type)
    else if (item.group === 'field') makeField(block.id, item.type)
    else changeBlockType(block.id, item.type)
    setSlashOpen(false)
    // У image нет редактируемого заголовка (ImageField, labelRef=null) — фокусировать
    // нечего; продолжаем поток текстовой строкой ниже. У бандла/подписи фокус на
    // текущий блок (стал title); у голого поля textarea нет — focusLabelEnd no-op.
    if (item.type === 'image') onAddBelow(block.id)
    else requestAnimationFrame(focusLabelEnd)
  }

  const iconBtn =
    'flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground'

  // Высота кластеров значков = line-height ПЕРВОЙ строки блока (fields.css):
  // вопрос rf-label — 28px (h-7), абзац rf-text и согласие rf-consent — 24px (h-6).
  // Кластеры absolute и центрируют значок по своей высоте, поэтому только так они
  // стоят на уровне текста. Жёсткое значение тут — баг: при h-8 (32px) значки висят
  // ниже строки у всех типов сразу. Меняется вместе с line-height в fields.css.
  const rowLineH = block.type === 'title' || block.type === 'heading' ? 'h-7' : 'h-6'

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative rounded-md py-1.5 ${isDragging ? 'z-10 opacity-70' : ''}`}
    >
      {/* Все элементы управления — в левом поле (вне колонки текста, absolute), поэтому
          сам текст остаётся по центру колонки. Всегда видимы; высота кластера =
          line-height первой строки блока (rowLineH) + items-center → значки на
          уровне текста. Порядок: удалить, добавить,
          описание, перетащить (ручка последняя = ближайшая к тексту).

          Кластер absolute и проявляется через opacity — высоту строки он не меняет
          НИКОГДА, и это здесь не косметика, а требование корректности. Контрол,
          который появляется по hover/фокусу и при этом занимает место в потоке,
          схлопывается синхронно на mousedown (фокус уходит из блока → блок теряет
          :focus-within → высота падает): всё, что ниже, уезжает вверх, mouseup
          приходит уже мимо цели, и браузер диспатчит click на общего предка —
          обработчик кнопки не срабатывает. Именно так «+ Описание», стоявшее в
          потоке под заголовком, съедало первый клик по «+ Добавить блок» (TD-22).
          Любой новый reveal-on-hover контрол блока — только сюда. */}
      <div
        className={`absolute right-full top-1.5 mr-1 flex ${rowLineH} items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100`}
      >
        <button
          type="button"
          onClick={() => (isCaptionType(block.type) ? removeGroup(block.id) : removeBlock(block.id))}
          aria-label={isCaptionType(block.type) ? 'Удалить вопрос (группу)' : 'Удалить блок'}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => onInsertBelow(block.id)}
          aria-label="Добавить блок ниже (выбрать тип)"
          className={iconBtn}
        >
          <Plus className="size-4" />
        </button>
        {/* Описание — только у отвечаемых блоков (неотвечаемый text рендерится
            статикой, описания не имеет), как и RequiredToggle справа. */}

        <button
          type="button"
          {...(groupHandle ? groupHandle.attributes : attributes)}
          {...(groupHandle ? groupHandle.listeners : listeners)}
          aria-label={
            groupHandle && isCaptionType(block.type)
              ? 'Перетащить вопрос (группу)'
              : 'Перетащить блок'
          }
          className={`${iconBtn} cursor-grab active:cursor-grabbing`}
        >
          <GripVertical className="size-4" />
        </button>
      </div>

      {/* Обязательность — в правом поле блока (за колонкой вопроса), зеркально
          левому кластеру значков. Только у отвечаемых блоков: неотвечаемый text
          ответов не собирает, required к нему неприменим. */}
      {isContent ? null : <RequiredToggle block={block} lineH={rowLineH} />}

      {/* Image (неотвечаемый) — загрузка/картинка вместо текстовой строки;
          менять тип у него нельзя, поэтому без SlashMenu и label-textarea. */}
      {isImage ? (
        <div className="min-w-0">
          <ImageField block={block} formId={formId} />
        </div>
      ) : hasTextLine ? (
        <SlashMenu open={slashOpen} onOpenChange={setSlashOpen} onPick={pickType}>
          <div className="min-w-0">
            <div className={isConsent ? 'flex items-start gap-2' : undefined}>
              {isConsent && (
                <span className="rf-mark rf-mark--check mt-0.5 shrink-0" aria-hidden="true" />
              )}
              <textarea
                ref={labelRef}
                rows={1}
                value={block.text ?? ''}
                placeholder={captionPh}
                onChange={(e) => updateBlock(block.id, { text: e.target.value })}
                onFocus={() => setLabelFocused(true)}
                onBlur={() => setLabelFocused(false)}
                onKeyDown={onLabelKeyDown}
                className={`w-full resize-none bg-transparent outline-none placeholder:text-muted-foreground/60 ${captionCls}`}
              />
            </div>
          </div>
        </SlashMenu>
      ) : (
        <div className="min-w-0">
          {isChoiceType(block.type) ? (
            <OptionsInline block={block} onLeaveTop={() => {}} />
          ) : block.type === 'scale' ? (
            <ScaleInline block={block} />
          ) : (
            <AnswerField block={block} />
          )}
        </div>
      )}
    </div>
  )
}

// RequiredToggle — контрол обязательности в правом поле блока (absolute left-full),
// зеркально левому кластеру значков. Это редактируемый контрол, а не индикатор:
// совпадать видом с звёздочкой rf-required рендерера не обязан, только менять
// block.required. Включённым виден всегда и подсвечен (показывает состояние),
// выключенным — проявляется на hover/фокусе строки. Настоящий <button aria-pressed>
// в Tab-обходе; текст состояния — в title/aria-label (значок компактен, как слева).
// lineH — высота строки блока (h-6/h-7), приходит из BlockRow: значок обязан стоять
// на уровне первой строки текста, а она разной высоты у вопроса и у согласия.
function RequiredToggle({ block, lineH }: { block: Block; lineH: string }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const required = block.required
  return (
    <div
      className={`absolute left-full top-1.5 ml-1 flex ${lineH} items-center transition-opacity ${
        required
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
      }`}
    >
      <button
        type="button"
        aria-pressed={required}
        aria-label={required ? 'Обязательный вопрос' : 'Сделать вопрос обязательным'}
        title={required ? 'Обязательный вопрос' : 'Сделать обязательным'}
        onClick={() => updateBlock(block.id, { required: !required })}
        className={`flex size-5 items-center justify-center rounded hover:bg-muted ${
          required ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <Asterisk className="size-4" />
      </button>
    </div>
  )
}


// AnswerField — поле ответа под вопросом. Для текстовых типов оно редактируемое:
// автор вводит сюда текст-плейсхолдер (settings.placeholder), который увидит
// респондент. date — статичное превью (в поле даты плейсхолдер не показывается).
// ScaleInline — редактор шкалы: живое превью делений (тот же rf-scale, что увидит
// респондент) плюс выбор диапазона.
//
// Концы выбираются из <select>, а не вводятся числом, намеренно: ValidateSchema
// строго требует min < max в пределах [0,10], а свободный ввод даёт невалидные
// промежуточные состояния (пустое поле, min>max посреди набора) — автосейв ловил бы
// 422 на каждое нажатие. Список вариантов делает такое состояние невозможным.
function ScaleInline({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const { min, max } = scaleRange(block)

  const set = (next: { min?: number; max?: number }) => {
    const m = next.min ?? min
    const x = next.max ?? max
    updateBlock(block.id, {
      // Максимум не может опуститься до минимума: держим его хотя бы на шаг выше.
      settings: { ...block.settings, scaleMin: m, scaleMax: Math.max(x, m + 1) },
    })
  }

  const selectCls =
    'h-7 rounded border border-muted-foreground/30 bg-transparent px-1.5 text-sm text-foreground'

  return (
    <div className="mt-2 flex flex-col gap-2">
      {/* Только контрол, без FieldShell: подпись рисует строка заголовка выше —
          оболочка дублировала бы её (вопрос стоял бы и над блоком, и над шкалой). */}
      <BlockControl block={block} />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <label className="flex items-center gap-1.5">
          от
          <select
            className={selectCls}
            value={min}
            onChange={(e) => set({ min: Number(e.target.value) })}
          >
            {[SCALE_LOWER_BOUND, SCALE_LOWER_BOUND + 1].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          до
          <select
            className={selectCls}
            value={max}
            onChange={(e) => set({ max: Number(e.target.value) })}
          >
            {Array.from({ length: SCALE_UPPER_BOUND - min }, (_, i) => min + 1 + i).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  )
}

function AnswerField({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const [focused, setFocused] = useState(false)
  const ph = block.settings?.placeholder ?? ''
  const setPh = (value: string) =>
    updateBlock(block.id, { settings: { ...block.settings, placeholder: value } })
  // Подсказку-хинт показываем только при фокусе (клике) на поле.
  const hint = focused ? 'Плейсхолдер ответа (необязательно)' : undefined
  // Вид поля — общий rf-input (единый с превью/рендерером); rf-input-typed даёт
  // место под глиф типа справа (см. index.css).
  const cls = 'rf-input rf-input-typed'

  // Глиф типа поля в правом углу — подсказка автору, ЧТО это за поле, когда
  // подпись ещё не написана. Только в редакторе: у респондента тип виден по
  // самому контролу, и в публичной форме Tally такого глифа нет (проверено
  // замером). Берём typeIcons — тот же словарь, что в slash-меню и диалоге
  // добавления, чтобы тип выглядел одинаково везде, где о нём говорят.
  // pointer-events-none обязателен: иначе глиф съедает клик по правому краю поля.
  const typeGlyph = (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute right-2 text-muted-foreground/70 ${
        block.type === 'long_text' ? 'top-2' : 'top-1/2 -translate-y-1/2'
      }`}
    >
      {typeIcons[block.type]}
    </span>
  )
  // Обёртка — только якорь глифа; ширину берёт из .rf-field-wrap (index.css),
  // где стоит тот же потолок --rf-input-max, что у поля. mt-2 — синхронно с gap
  // 0.5rem у .rf-field.
  const wrap = (control: ReactNode, wide = false) => (
    <div className={`rf-field-wrap mt-2 ${wide ? 'rf-field-wrap--wide' : ''}`}>
      {control}
      {typeGlyph}
    </div>
  )

  if (!supportsPlaceholder(block.type)) {
    return wrap(<input type="date" disabled className={`${cls} pointer-events-none`} />)
  }
  const focusProps = {
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  }
  if (block.type === 'long_text') {
    return wrap(
      <textarea
        value={ph}
        onChange={(e) => setPh(e.target.value)}
        rows={2}
        placeholder={hint}
        className={cls}
        {...focusProps}
      />,
      true,
    )
  }
  return wrap(
    <input
      value={ph}
      onChange={(e) => setPh(e.target.value)}
      placeholder={hint}
      className={cls}
      {...focusProps}
    />,
  )
}

// OptionsInline — варианты choice-блока строками прямо под вопросом, с глифом
// радио/чекбокса как у готового поля. Клавиатура: Enter — новый вариант (фокус на
// него), Backspace в пустом — удалить и уйти на предыдущий (или на заголовок).
function OptionsInline({ block, onLeaveTop }: { block: Block; onLeaveTop: () => void }) {
  const addOption = useBuilderStore((s) => s.addOption)
  const updateOption = useBuilderStore((s) => s.updateOption)
  const removeOption = useBuilderStore((s) => s.removeOption)
  const options = useMemo(() => block.settings?.options ?? [], [block.settings?.options])
  const optionRefs = useRef(new Map<string, HTMLInputElement | null>())
  // Запрос фокуса держим в ref, а не в state: после add/remove опций стор меняет
  // массив → эффект переставляет фокус, не вызывая лишний ре-рендер (setState в
  // эффекте под запретом линта). 'last' — на последнюю опцию (после Enter/добавления).
  const pendingFocus = useRef<string | 'last' | null>(null)

  useEffect(() => {
    const req = pendingFocus.current
    if (req === null) return
    const id = req === 'last' ? options[options.length - 1]?.id : req
    if (id) optionRefs.current.get(id)?.focus()
    pendingFocus.current = null
  }, [options])

  function onOptionKeyDown(e: KeyboardEvent<HTMLInputElement>, optionId: string, i: number) {
    if (e.key === 'Enter') {
      e.preventDefault()
      pendingFocus.current = 'last'
      addOption(block.id)
    } else if (e.key === 'Backspace' && e.currentTarget.value === '') {
      e.preventDefault()
      const prev = options[i - 1]
      removeOption(block.id, optionId)
      if (prev) pendingFocus.current = prev.id
      else onLeaveTop()
    }
  }

  return (
    // items-start — карточки обнимают текст, как .rf-options у респондента;
    // gap-3 = 0.75rem там же.
    <div className="mt-2 flex flex-col items-start gap-3">
      {options.map((o, i) => {
        const placeholder = `Вариант ${i + 1}`
        const key = optionKey(i)
        return (
          // Кнопка удаления — ВНЕ карточки и с постоянно занятым местом (меняется
          // только opacity): контрол, появляющийся по hover в потоке, схлопывается
          // на mousedown и съедает клик — TD-22, разбор у кластера значков выше.
          <div key={o.id} className="flex items-center gap-1">
            <span className="rf-option">
              {/* Буква — та же декоративная подсказка, что видит респондент
                  (rf-option-key). Глиф радио/чекбокса у карточки не рисуется ни
                  тут, ни в форме: «один из» против «несколько из» показывает
                  превью, где виден настоящий контрол. */}
              {key && (
                <span className="rf-option-key" aria-hidden="true">
                  {key}
                </span>
              )}
              {/* data-value — копия текста, задающая ширину (см. .rf-option-edit
                  в index.css). Пустой вариант меряется по плейсхолдеру, иначе
                  карточка схлопнулась бы в точку. */}
              <span className="rf-option-edit" data-value={o.label || placeholder}>
                <input
                  ref={(el) => {
                    optionRefs.current.set(o.id, el)
                  }}
                  value={o.label}
                  placeholder={placeholder}
                  aria-label={placeholder}
                  onChange={(e) => updateOption(block.id, o.id, e.target.value)}
                  onKeyDown={(e) => onOptionKeyDown(e, o.id, i)}
                  className="bg-transparent outline-none placeholder:text-muted-foreground"
                />
              </span>
            </span>
            <button
              type="button"
              onClick={() => removeOption(block.id, o.id)}
              aria-label="Удалить вариант"
              className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        onClick={() => {
          pendingFocus.current = 'last'
          addOption(block.id)
        }}
        // Служебный ярус (14px), а не тело формы: это контрол редактора, которого
        // респондент не видит — как «+ Добавить блок» ниже по полотну. Был text-base
        // и читался как ещё один вариант ответа.
        className="flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-4" /> Добавить вариант
      </button>
    </div>
  )
}
