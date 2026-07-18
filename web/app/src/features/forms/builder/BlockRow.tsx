import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Asterisk, GripVertical, Plus, Text, Trash2, X } from 'lucide-react'
import {
  type Block,
  type BlockType,
  isChoiceType,
  isSingleChoiceType,
  isContentType,
  SCALE_LOWER_BOUND,
  SCALE_UPPER_BOUND,
  scaleRange,
  supportsPlaceholder,
} from '@entities/formSchema'
import { BlockControl } from '@fields/BlockField'
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
  const changeBlockType = useBuilderStore((s) => s.changeBlockType)
  const labelRef = useRef<HTMLTextAreaElement>(null)
  // Строку создали по «/» → меню типов открыто с монтирования (без setState в эффекте).
  const [slashOpen, setSlashOpen] = useState(openMenuOnMount)
  // Описание вопроса: раскрыто ли поле. Непустое описание раскрыто с монтирования.
  // Триггер раскрытия живёт в левом кластере значков (absolute) — см. коммент там.
  const descRef = useRef<HTMLTextAreaElement>(null)
  const [descOpen, setDescOpen] = useState((block.description ?? '').trim().length > 0)
  // Плейсхолдер заголовка виден только у активной (в фокусе) строки: неактивный
  // пустой блок ничего не показывает.
  const [labelFocused, setLabelFocused] = useState(false)
  const isContent = isContentType(block.type)
  const isImage = block.type === 'image'
  // Согласие правится строкой заголовка (текст согласия = label), поэтому у него
  // нет отдельного превью-контрола: галочка стоит слева от самого текста.
  const isConsent = block.type === 'consent'

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
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
  }, [block.label])

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
  function openDescription() {
    setDescOpen(true)
    requestAnimationFrame(() => descRef.current?.focus())
  }

  function pickType(type: BlockType) {
    changeBlockType(block.id, type)
    setSlashOpen(false)
    // У image нет редактируемого заголовка (рендерится ImageField, labelRef=null) —
    // фокусировать нечего. Продолжаем поток новой текстовой строкой ниже (как Notion):
    // каретка не пропадает, можно печатать дальше; картинку грузишь кликом по зоне.
    if (type === 'image') onAddBelow(block.id)
    else requestAnimationFrame(focusLabelEnd)
  }

  const iconBtn =
    'flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground'

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`group relative rounded-md py-1.5 ${isDragging ? 'z-10 opacity-70' : ''}`}
    >
      {/* Все элементы управления — в левом поле (вне колонки текста, absolute), поэтому
          сам текст остаётся по центру колонки. Всегда видимы; h-8 + items-center и
          leading-8 у текста → значки на уровне строки. Порядок: удалить, добавить,
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
      <div className="absolute right-full top-1.5 mr-1 flex h-8 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={() => removeBlock(block.id)}
          aria-label="Удалить блок"
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
        {isContent ? null : (
          <button
            type="button"
            onClick={openDescription}
            aria-label="Описание вопроса"
            title="Описание вопроса"
            className={iconBtn}
          >
            <Text className="size-4" />
          </button>
        )}
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Перетащить блок"
          className={`${iconBtn} cursor-grab active:cursor-grabbing`}
        >
          <GripVertical className="size-4" />
        </button>
      </div>

      {/* Обязательность — в правом поле блока (за колонкой вопроса), зеркально
          левому кластеру значков. Только у отвечаемых блоков: неотвечаемый text
          ответов не собирает, required к нему неприменим. */}
      {isContent ? null : <RequiredToggle block={block} />}

      {/* Image (неотвечаемый) — загрузка/картинка + alt вместо текстовой строки;
          менять тип у него нельзя, поэтому без SlashMenu и label-textarea. */}
      {isImage ? (
        <div className="min-w-0">
          <ImageField block={block} formId={formId} />
        </div>
      ) : (
        <SlashMenu open={slashOpen} onOpenChange={setSlashOpen} onPick={pickType}>
          <div className="min-w-0">
            {/* Согласие: галочка слева от правимого текста — как у респондента.
                Декоративная (rf-mark, как глифы вариантов в OptionsInline):
                настоящий <input> тут не нужен, состояние правит респондент. mt-1
                центрирует size-4 по строке rf-consent (line-height 1.5rem). */}
            <div className={isConsent ? 'flex items-start gap-2' : undefined}>
              {isConsent && (
                <span className="rf-mark rf-mark--check mt-1 shrink-0" aria-hidden="true" />
              )}
              <textarea
                ref={labelRef}
                rows={1}
                value={block.label}
                // Текстовый блок прячет плейсхолдер вне фокуса: пустой абзац — это
                // осознанный пропуск строки, и подсказка в нём выглядит как мусор.
                // У остальных блоков пустой заголовок — незаполненный вопрос, поэтому
                // подсказка видна всегда. У вопроса «/» уже не работает (тип выбран) —
                // подсказку про слэш не показываем.
                placeholder={
                  isContent
                    ? labelFocused
                      ? 'Текст, или «/» для поля'
                      : undefined
                    : isConsent
                      ? 'Текст согласия'
                      : 'Введите текст вопроса'
                }
                onChange={(e) => updateBlock(block.id, { label: e.target.value })}
                onFocus={() => setLabelFocused(true)}
                onBlur={() => setLabelFocused(false)}
                onKeyDown={onLabelKeyDown}
                className={`w-full resize-none bg-transparent outline-none placeholder:text-muted-foreground/60 ${
                  isContent
                    ? 'rf-text placeholder:font-normal'
                    : isConsent
                      ? // Текст согласия — обычная фраза рядом с галочкой, не вопрос:
                        // тот же rf-consent, что у респондента (иначе редактор показывал
                        // бы юридическую строку крупным полужирным).
                        'rf-consent placeholder:font-normal'
                      : 'rf-label placeholder:font-semibold'
                }`}
              />
            </div>

            {/* Описание вопроса (block.description) — только у отвечаемых блоков:
                неотвечаемый text описания не имеет (рендерится статикой). Раскрывается
                значком в левом кластере; пустое при потере фокуса сворачивается. */}
            {isContent || !descOpen ? null : (
              <DescriptionField
                block={block}
                inputRef={descRef}
                onEmptyBlur={() => setDescOpen(false)}
              />
            )}

            {/* Text (неотвечаемый) — только абзац. Choice — варианты. Шкала — деления
                и диапазон. Согласие — ничего: галочка и текст уже в строке выше.
                Остальные (поля ввода) — редактируемое поле ответа с плейсхолдером. */}
            {isContent || isConsent ? null : isChoiceType(block.type) ? (
              <OptionsInline block={block} onLeaveTop={focusLabelEnd} />
            ) : block.type === 'scale' ? (
              <ScaleInline block={block} />
            ) : (
              <AnswerField block={block} />
            )}
          </div>
        </SlashMenu>
      )}
    </li>
  )
}

// RequiredToggle — контрол обязательности в правом поле блока (absolute left-full),
// зеркально левому кластеру значков. Это редактируемый контрол, а не индикатор:
// совпадать видом с звёздочкой rf-required рендерера не обязан, только менять
// block.required. Включённым виден всегда и подсвечен (показывает состояние),
// выключенным — проявляется на hover/фокусе строки. Настоящий <button aria-pressed>
// в Tab-обходе; текст состояния — в title/aria-label (значок компактен, как слева).
function RequiredToggle({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const required = block.required
  return (
    <div
      className={`absolute left-full top-1.5 ml-1 flex h-8 items-center transition-opacity ${
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

// DescriptionField — редактируемое описание вопроса (block.description). Рендерер
// показывает его как rf-desc под подписью (FieldShell) — тот же вид и в редакторе
// (WYSIWYG, класс rf-desc из fields.css).
//
// Раскрытием владеет BlockRow, а не это поле: триггер («Описание вопроса») стоит в
// левом absolute-кластере значков, чтобы появление контрола не двигало высоту
// строки. Прежняя кнопка «+ Описание» жила прямо здесь, в потоке, и схлопывалась на
// mousedown — из-за чего терялся клик по элементам ниже (TD-22, разбор — в комменте
// у кластера). Сюда контролы, зависящие от hover/фокуса, больше не добавляем.
// Пустое описание при потере фокуса сворачивается обратно (onEmptyBlur).
function DescriptionField({
  block,
  inputRef,
  onEmptyBlur,
}: {
  block: Block
  inputRef: RefObject<HTMLTextAreaElement | null>
  onEmptyBlur: () => void
}) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const desc = block.description ?? ''

  useEffect(() => {
    autosize(inputRef.current)
  }, [desc, inputRef])

  return (
    <textarea
      ref={inputRef}
      rows={1}
      value={desc}
      onChange={(e) => updateBlock(block.id, { description: e.target.value })}
      onBlur={() => {
        if (!desc.trim()) onEmptyBlur()
      }}
      placeholder="Описание (необязательно)"
      aria-label="Описание вопроса"
      className="rf-desc mt-1 w-full resize-none bg-transparent outline-none placeholder:text-muted-foreground/50"
    />
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
    <div className="mt-1.5 flex flex-col gap-2">
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
  // Вид поля — общий rf-input (единый с превью/рендерером); mt-1.5 — layout редактора.
  const cls = 'rf-input mt-1.5'

  if (!supportsPlaceholder(block.type)) {
    return <input type="date" disabled className={`${cls} max-w-56 pointer-events-none`} />
  }
  const focusProps = {
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  }
  if (block.type === 'long_text') {
    return (
      <textarea
        value={ph}
        onChange={(e) => setPh(e.target.value)}
        rows={2}
        placeholder={hint}
        className={cls}
        {...focusProps}
      />
    )
  }
  return (
    <input
      value={ph}
      onChange={(e) => setPh(e.target.value)}
      placeholder={hint}
      className={cls}
      {...focusProps}
    />
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
    <div className="mt-1.5 flex flex-col gap-1.5">
      {options.map((o, i) => (
        <div key={o.id} className="flex items-center gap-2">
          {/* Глиф в редакторе сообщает «один из» против «несколько из», а не точный
              контрол: у dropdown респондент видит select, поэтому берём предикат
              одиночного выбора, а не сравнение с single_choice (иначе dropdown
              получил бы чекбокс — прямая ложь). Настоящий вид — в превью. */}
          <span
            className={`rf-mark ${isSingleChoiceType(block.type) ? 'rf-mark--radio' : 'rf-mark--check'}`}
            aria-hidden="true"
          />
          <input
            ref={(el) => {
              optionRefs.current.set(o.id, el)
            }}
            value={o.label}
            placeholder={`Вариант ${i + 1}`}
            aria-label={`Вариант ${i + 1}`}
            onChange={(e) => updateOption(block.id, o.id, e.target.value)}
            onKeyDown={(e) => onOptionKeyDown(e, o.id, i)}
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={() => removeOption(block.id, o.id)}
            aria-label="Удалить вариант"
            className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          pendingFocus.current = 'last'
          addOption(block.id)
        }}
        className="flex w-fit items-center gap-2 text-base text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-4" /> Добавить вариант
      </button>
    </div>
  )
}
