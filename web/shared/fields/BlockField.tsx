import { type Block, isContentType, plainText } from '@entities/formSchema'

import { type Answer } from './answer'
import { FieldShell } from './FieldShell'
import { CONTROLS, type ControlProps } from './kinds/index'
import { mediaSrc } from './media'
import { RichText } from './richText'

// RichText реэкспортируется отсюда: он переехал в свой модуль (иначе контрол согласия
// импортировал бы этот файл, а этот — реестр контролов, и импорты замкнулись бы в цикл),
// но точка входа для потребителей не менялась.
export { RichText } from './richText'

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

// cx — склейка классов без зависимостей: в @fields нет ни Tailwind, ни clsx (бюджет
// рендерера). Пустое имя не должно давать висячий пробел в атрибуте.
function cx(...names: (string | undefined)[]): string {
  return names.filter(Boolean).join(' ')
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
  // СВОЁ ИМЯ БЛОКА (фаза 22, слайс 7) едет на КОРЕНЬ его элемента, рядом с нашими
  // rf-*. Не обёрткой: лишний div сдвинул бы блок в потоке .rf-group, где ритм
  // держится соседством, — и вид формы поехал бы у всех, включая тех, кто своим CSS
  // не пользуется.
  const own = block.class
  if (isContentType(block.type)) {
    // image: картинка по ключу. Без ключа (недособранный черновик) блок не
    // схлопывается, а держит место высотой с зону загрузки редактора (rf-image-empty).
    // loading/decoding: форма с несколькими картинками иначе тянет их все разом и
    // полным приоритетом. Эту ветку видят превью билдера и публичный рендерер
    // (полотно редактора рисует картинку своим ImageField.tsx). Первую картинку из
    // lazy не исключаем — прокидывать «я первый» пришлось бы через всех вызывающих,
    // а картинка почти никогда не LCP-элемент: сверху формы стоит заголовок.
    if (block.type === 'image') {
      const key = block.settings?.imageKey
      return key ? (
        <img className={cx('rf-image', own)} src={mediaSrc(key)} alt="" loading="lazy" decoding="async" />
      ) : (
        <div className={cx('rf-image-empty', own)} aria-hidden="true" />
      )
    }
    // text — статический абзац. Пустой блок держит место (одна строка rf-text), а не
    // схлопывается: недособранный черновик остаётся видимым пустым пространством.
    return <ContentBlock block={block} required={captionRequired} inert={disabled} own={own} />
  }

  const errorId = error ? `${block.id}-error` : undefined
  // aria отвечаемого поля: подпись группы, иначе плейсхолдер, иначе фолбэк.
  const aria = captionText?.trim() || block.settings?.placeholder?.trim() || 'Поле'
  return (
    <FieldShell error={error} errorId={errorId} own={own}>
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
function ContentBlock({
  block,
  required,
  inert,
  own,
}: {
  block: Block
  required?: boolean
  inert?: boolean
  /** Своё имя блока для CSS автора (фаза 22). */
  own?: string
}) {
  if (block.type === 'image') {
    const key = block.settings?.imageKey
    return key ? (
      <img className={cx('rf-image', own)} src={mediaSrc(key)} alt="" loading="lazy" decoding="async" />
    ) : (
      <div className={cx('rf-image-empty', own)} aria-hidden="true" />
    )
  }
  // Разрыв страницы у респондента не рисуется: он граница, а не элемент страницы, и
  // потребляет его splitPages. Сюда он попадает только с поверхности, которая страниц
  // ещё не знает (превью билдера до шага 4), — и там обязан быть невидимым, а не
  // пустым абзацем из общей ветки ниже.
  if (block.type === 'page_break') return null

  const text = plainText(block.text).trim()
  // Заголовок формы (фаза 15) — <h1> страницы, а не строка вопроса. Пустой не
  // рисуется вовсе (решение владельца): форма начинается с первого вопроса, а
  // служебное «Untitled form» из колонки респонденту больше не достаётся. Заглушка
  // «Без названия», как у пустой подписи, здесь была бы враньём — автор стёр
  // заголовок намеренно.
  if (block.type === 'form_title') {
    return text ? (
      <h1 className={cx('rf-title', own)}>
        <RichText spans={block.text} inert={inert} carrier={block.id} />
      </h1>
    ) : null
  }
  if (block.type === 'title' || block.type === 'label') {
    return (
      <div className={cx(block.type === 'label' ? 'rf-label rf-label--sm' : 'rf-label', own)}>
        {text ? <RichText spans={block.text} inert={inert} carrier={block.id} /> : 'Без названия'}
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
    return (
      <div className={cx('rf-heading', own)}>
        {text ? (
          <RichText spans={block.text} inert={inert} carrier={block.id} />
        ) : (
          'Заголовок раздела'
        )}
      </div>
    )
  }
  return (
    <p className="rf-text">
      {text ? <RichText spans={block.text} inert={inert} carrier={block.id} /> : ' '}
    </p>
  )
}

// FieldControl — диспетчер по реестру контролов (kinds/index.ts). Ветвления по типу
// здесь больше нет: контрол типа живёт в файле типа, а этот файл отвечает за оболочку
// (FieldShell), контекст группы и контент.
//
// null у неотвечаемых — объявленный в реестре факт, а не «сюда не дойдёт»: до FieldControl
// такие типы действительно не доходят (BlockField отсекает их выше), но полагаться на
// это молча значило бы вернуть тот же класс ошибки, который этап убирает.
function FieldControl(props: ControlProps) {
  const Control = CONTROLS[props.block.type]
  if (!Control) return null
  return <Control {...props} />
}
