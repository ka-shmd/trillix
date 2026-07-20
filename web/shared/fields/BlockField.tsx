import { type ChangeEvent } from 'react'

import { CONSENT_YES, type Block, isContentType, scaleRange } from '@entities/formSchema'

import { type Answer, optionKey, toggleMulti } from './answer'
import { FieldShell } from './FieldShell'
import { mediaSrc } from './media'

// BlockField — как один блок увидит человек, заполняющий форму. Два режима одним
// кодом (не разъезжаться — web/CLAUDE.md):
//   • превью билдера — без value/onChange, disabled по умолчанию: контролы видны,
//     но не редактируются (PreviewPane зовёт <BlockField block={block} />);
//   • рендерер — disabled={false} + управляемые value/onChange (фаза 4).
// Диспетчер по block.type; switch исчерпывающий (контентные типы обрабатываются
// выше, отвечаемые — в FieldControl; все ветки возвращают значение).
type BlockFieldProps = {
  block: Block
  // Контекст группы (v2): подпись группы — для aria поля; обязательность — для
  // звёздочки у блока-подписи. Передаёт раскладчик групп (FormView/PreviewPane).
  captionText?: string
  captionRequired?: boolean
  value?: Answer
  onChange?: (next: Answer) => void
  disabled?: boolean
  // Рендерер: сообщение об ошибке валидации и колбэк потери фокуса (проверка по
  // blur). В превью билдера отсутствуют — поле ведёт себя как раньше.
  error?: string
  onBlur?: () => void
}

export function BlockField({
  block,
  captionText,
  captionRequired,
  value,
  onChange,
  disabled = true,
  error,
  onBlur,
}: BlockFieldProps) {
  // Неотвечаемый (контентный) блок — статический контент: без подписи-вопроса,
  // звёздочки, контрола и ошибок.
  if (isContentType(block.type)) {
    // image: картинка по ключу. Без ключа (недособранный черновик) блок не
    // схлопывается, а держит место высотой с зону загрузки редактора (rf-image-empty).
    if (block.type === 'image') {
      const key = block.settings?.imageKey
      return key ? (
        <img className="rf-image" src={mediaSrc(key)} alt={block.settings?.alt ?? ''} />
      ) : (
        <div className="rf-image-empty" aria-hidden="true" />
      )
    }
    // text — статический абзац. Пустой блок держит место (одна строка rf-text), а не
    // схлопывается: недособранный черновик остаётся видимым пустым пространством.
    return <ContentBlock block={block} required={captionRequired} />
  }

  const errorId = error ? `${block.id}-error` : undefined
  // aria отвечаемого поля: подпись группы, иначе плейсхолдер, иначе фолбэк.
  const aria = captionText?.trim() || block.settings?.placeholder?.trim() || 'Поле'
  return (
    <FieldShell error={error} errorId={errorId}>
      <FieldControl
        block={block}
        label={aria}
        value={value}
        onChange={onChange}
        disabled={disabled}
        invalid={!!error}
        errorId={errorId}
        onBlur={onBlur}
      />
    </FieldShell>
  )
}

// BlockControl — только контрол поля, без оболочки FieldShell (подпись, звёздочка,
// описание, ошибка). Нужен редактору: подпись он рисует сам — редактируемой
// строкой сверху, и оболочка дублировала бы её. Тот же контрол, что видит
// респондент, поэтому вид не разъезжается (превью и рендерер берут BlockField
// целиком, с оболочкой).
export function BlockControl({ block }: { block: Block }) {
  const aria = block.settings?.placeholder?.trim() || 'Поле'
  return <FieldControl block={block} label={aria} disabled={true} invalid={false} />
}

// ContentBlock — неотвечаемый блок: подпись группы (title крупная / label мелкая),
// заголовок раздела (heading), абзац (text) или картинка (image). Звёздочку
// обязательности несёт подпись, если у поля группы стоит required.
function ContentBlock({ block, required }: { block: Block; required?: boolean }) {
  if (block.type === 'image') {
    const key = block.settings?.imageKey
    return key ? (
      <img className="rf-image" src={mediaSrc(key)} alt={block.settings?.alt ?? ''} />
    ) : (
      <div className="rf-image-empty" aria-hidden="true" />
    )
  }
  const text = (block.text ?? '').trim()
  if (block.type === 'title' || block.type === 'label') {
    return (
      <div className={block.type === 'label' ? 'rf-label rf-label--sm' : 'rf-label'}>
        {text || 'Без названия'}
        {required && (
          <span className="rf-required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </div>
    )
  }
  if (block.type === 'heading') {
    return <div className="rf-heading">{text || 'Заголовок раздела'}</div>
  }
  return <p className="rf-text">{text || ' '}</p>
}

type ControlProps = {
  block: Block
  label: string
  value?: Answer
  onChange?: (next: Answer) => void
  disabled: boolean
  invalid: boolean
  errorId?: string
  onBlur?: () => void
}

function FieldControl({ block, label, value, onChange, disabled, invalid, errorId, onBlur }: ControlProps) {
  // Текстовые контролы управляемые: пустая строка вместо undefined, чтобы React
  // не переключал input между controlled/uncontrolled. onChange присутствует
  // всегда (иначе React ругается на value без onChange); в превью не срабатывает.
  const text = typeof value === 'string' ? value : ''
  // Плейсхолдер поля из настроек (автор задаёт его в билдере); пусто → undefined.
  const ph = block.settings?.placeholder?.trim() || undefined
  const onText = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange?.(e.target.value)
  // Общие a11y-атрибуты текстовых полей: пометка невалидности и связь с
  // сообщением об ошибке. undefined убирает атрибут в валидном состоянии.
  const invalidProps = {
    'aria-invalid': invalid || undefined,
    'aria-describedby': invalid ? errorId : undefined,
    onBlur,
  }

  switch (block.type) {
    case 'short_text':
      return (
        <input
          className="rf-input"
          type="text"
          value={text}
          onChange={onText}
          disabled={disabled}
          aria-label={label}
          placeholder={ph}
          {...invalidProps}
        />
      )
    case 'long_text':
      return (
        <textarea
          className="rf-input"
          rows={3}
          value={text}
          onChange={onText}
          disabled={disabled}
          aria-label={label}
          placeholder={ph}
          {...invalidProps}
        />
      )
    case 'email':
      return (
        <input
          className="rf-input"
          type="email"
          value={text}
          onChange={onText}
          disabled={disabled}
          aria-label={label}
          placeholder={ph ?? 'you@example.com'}
          {...invalidProps}
        />
      )
    case 'phone':
      return (
        <input
          className="rf-input"
          type="tel"
          value={text}
          onChange={onText}
          disabled={disabled}
          aria-label={label}
          placeholder={ph ?? '+7 900 000-00-00'}
          {...invalidProps}
        />
      )
    case 'number':
      return (
        <input
          className="rf-input"
          type="number"
          value={text}
          onChange={onText}
          disabled={disabled}
          aria-label={label}
          placeholder={ph}
          {...invalidProps}
        />
      )
    case 'date':
      return (
        <input
          className="rf-input"
          type="date"
          value={text}
          onChange={onText}
          disabled={disabled}
          aria-label={label}
          {...invalidProps}
        />
      )
    // Согласие: галочка с текстом владельца рядом (текст — label блока; оболочка
    // FieldShell его не дублирует). Обязательность — обычный флаг required
    // (решение владельца): необязательное согласие это маркетинг-opt-in.
    // Значение — CONSENT_YES/пусто, строкой: тип Answer не расширяется, а «пусто»
    // даёт обязательность даром (см. isEmpty в validation.ts).
    case 'consent':
      return (
        <label className="rf-option">
          <input
            className="rf-mark rf-mark--check"
            type="checkbox"
            checked={text === CONSENT_YES}
            onChange={(e) => onChange?.(e.target.checked ? CONSENT_YES : '')}
            disabled={disabled}
            {...invalidProps}
          />
          <span className="rf-consent">
            {(block.text ?? '').trim() || 'Текст согласия'}
            {block.required && (
              <span className="rf-required" aria-hidden="true"> *</span>
            )}
          </span>
        </label>
      )
    case 'scale':
      return (
        <ScaleChoice
          block={block}
          value={text}
          onChange={onChange}
          disabled={disabled}
          label={label}
          onBlur={onBlur}
        />
      )
    case 'single_choice':
      return (
        <ChoiceList block={block} multiple={false} value={value} onChange={onChange} disabled={disabled} onBlur={onBlur} />
      )
    case 'dropdown':
      return (
        <DropdownChoice
          block={block}
          value={value}
          onChange={onChange}
          disabled={disabled}
          label={label}
          {...invalidProps}
        />
      )
    case 'multi_choice':
      return (
        <ChoiceList block={block} multiple={true} value={value} onChange={onChange} disabled={disabled} onBlur={onBlur} />
      )
    case 'text':
    case 'image':
      // Контентные блоки обрабатываются в BlockField до FieldShell; сюда не
      // доходят — ветки для исчерпывающести switch по типам.
      return null
  }
}

// Шкала: ряд кнопок-делений от min до max (диапазон — из настроек блока). Ответ
// хранится строкой с целым числом — как number и date (конвенция проекта), поэтому
// тип Answer не расширяется.
//
// Настоящие <button>, а не radio: нажатие сразу даёт значение, а группу радио
// пришлось бы обходить стрелками. Выбранное деление помечается aria-pressed —
// скринридер читает состояние.
function ScaleChoice({
  block,
  value,
  onChange,
  disabled,
  label,
  onBlur,
}: {
  block: Block
  value: string
  onChange?: (next: Answer) => void
  disabled: boolean
  label: string
  onBlur?: () => void
}) {
  const { min, max } = scaleRange(block)
  const marks = Array.from({ length: max - min + 1 }, (_, i) => min + i)
  return (
    <div className="rf-scale" role="group" aria-label={label} onBlur={onBlur}>
      {marks.map((n) => {
        const selected = value === String(n)
        return (
          <button
            key={n}
            type="button"
            className={`rf-scale-mark${selected ? ' rf-scale-mark--on' : ''}`}
            aria-pressed={selected}
            disabled={disabled}
            // Повторное нажатие снимает выбор: иначе необязательную шкалу нельзя
            // было бы очистить, промахнувшись.
            onClick={() => onChange?.(selected ? '' : String(n))}
          >
            {n}
          </button>
        )
      })}
    </div>
  )
}

// Выпадающий список: та же модель опций и тот же формат ответа, что у
// single_choice (id варианта строкой) — отличается только контролом. Нативный
// <select>: на телефоне он открывается системным колесом, а длинный список не
// распирает форму на пол-экрана (ради этого тип и заведён).
//
// Пустой первый пункт — это «не выбрано»: без него select показывал бы первый
// вариант выбранным, и необязательный вопрос молча получал бы ответ.
function DropdownChoice({
  block,
  value,
  onChange,
  disabled,
  label,
  ...invalidProps
}: {
  block: Block
  value?: Answer
  onChange?: (next: Answer) => void
  disabled: boolean
  label: string
  'aria-invalid'?: true
  'aria-describedby'?: string
  onBlur?: () => void
}) {
  const options = block.settings?.options ?? []
  if (options.length === 0) {
    return <p className="rf-empty">Варианты пока не добавлены</p>
  }
  return (
    <select
      className="rf-input rf-select"
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange?.(e.target.value)}
      disabled={disabled}
      aria-label={label}
      {...invalidProps}
    >
      <option value="">Выберите вариант</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label.trim() || 'Вариант'}
        </option>
      ))}
    </select>
  )
}

// Список вариантов choice-блока: радиокнопки для одиночного выбора, чекбоксы для
// множественного. Без вариантов — заметка вместо пустоты (в черновике это норма).
// Управляемый: checked считается из value, изменение — через onChange (в multi
// массив правит toggleMulti).
function ChoiceList({
  block,
  multiple,
  value,
  onChange,
  disabled,
  onBlur,
}: {
  block: Block
  multiple: boolean
  value?: Answer
  onChange?: (next: Answer) => void
  disabled: boolean
  onBlur?: () => void
}) {
  const options = block.settings?.options ?? []
  if (options.length === 0) {
    return <p className="rf-empty">Варианты пока не добавлены</p>
  }
  const selectedMany = Array.isArray(value) ? value : []
  const selectedOne = typeof value === 'string' ? value : ''
  const onToggle = (id: string, checked: boolean) => {
    if (!onChange) return
    onChange(multiple ? toggleMulti(selectedMany, id, checked) : id)
  }
  return (
    <div className="rf-options" role="group" aria-label="Варианты ответа" onBlur={onBlur}>
      {options.map((o, i) => {
        const checked = multiple ? selectedMany.includes(o.id) : selectedOne === o.id
        const key = optionKey(i)
        return (
          // Состояние выбора — классом от React, а не CSS-селектором :has(:checked):
          // класс работает одинаково во всех браузерах и виден в тестах.
          <label key={o.id} className={`rf-option${checked ? ' rf-option--on' : ''}`}>
            <input
              className="rf-choice-input"
              type={multiple ? 'checkbox' : 'radio'}
              name={block.id}
              checked={checked}
              onChange={(e) => onToggle(o.id, e.target.checked)}
              disabled={disabled}
            />
            {key && (
              <span className="rf-option-key" aria-hidden="true">
                {key}
              </span>
            )}
            <span>{o.label.trim() || 'Вариант'}</span>
          </label>
        )
      })}
    </div>
  )
}
