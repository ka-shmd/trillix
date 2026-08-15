// Заголовок формы — первая строка полотна (фаза 15, спека §3.6). До неё заголовок
// жил в колонке БД и правился отдельным дебаунс-PATCH'ем: без разметки, без Mod+Z
// (поле было НЕуправляемым специально, чтобы отдать отмену браузеру), со своим
// флашем и своим beforeunload. Теперь это блок документа, и всё перечисленное
// приезжает даром: богатый текст, история стора, автосейв схемы.
//
// Почему своя строка, а не BlockRow: у BlockRow внутри `useSortable`, кластер
// значков, меню действий и обход стрелками как у равного блока — а заголовок
// приколот (не удаляется, не таскается, Alt+↑↓ ему нечего двигать). Собирать эти
// «нельзя» отрицаниями внутри BlockRow значило бы добавить туда шестую ветку
// «а если это заголовок»; отдельная строка честнее и короче.
//
// Рисуется ВНЕ потока вопросов (перед списком групп) — как и в превью с рендерером:
// иначе заголовок попал бы внутрь .rf-form и получил её ритм вместо своего (48px
// заголовок→форма). Разделяет поток общий `splitFormTitle` (@fields/groups).

import { useEffect, useRef, type KeyboardEvent } from 'react'
import { type Block, MAX_FORM_TITLE_LEN, plainText, type Span } from '@entities/formSchema'

import { useRowFocus } from './activeRow'
import { useRegisterFocusTarget } from './focusEngine'
import { RichLine } from './RichLine'
import { richCaret } from './richCaret'
import { textIsBold } from './kinds/index'
import { BOLD_MARKS } from './richText'
import { chords } from './shortcuts'
import type { UpdateKind } from './store'
import { useBuilderStore } from './storeContext'

export function FormTitleRow({ block, onEnter }: { block: Block; onEnter: () => void }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const ref = useRef<HTMLDivElement | null>(null)
  // Контекст подсказок — свой ('title'): блочных клавиш у заголовка нет, а Enter/↓
  // уводят на первую строку формы (карта в shortcuts.ts).
  const rowFocus = useRowFocus(block.id, 'title')
  // Та же регистрация в фокус-движке, что у любой строки: контракт фокуса (§12
  // EDITOR.md) обещает «предыдущая остановка», и с первой строки полотна она ведёт
  // сюда. Заголовок адресуется id блока, а не сентинелом, — он теперь блок.
  useRegisterFocusTarget(block.id, (edge) => {
    const el = ref.current
    if (el) richCaret(el).focus(edge)
  })

  // При заходе на форму каретка встаёт в начало заголовка — как было у поля до фазы.
  useEffect(() => {
    const el = ref.current
    if (el) richCaret(el).focus('start')
  }, [])

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    // Enter не заводит перевод строки: заголовок логически однострочный (переносится
    // визуально при отрисовке). Enter и ↓ уводят на первый блок формы.
    if (chords.enter(e) || chords.arrowDown(e)) {
      e.preventDefault()
      onEnter()
    }
    // Backspace в начале схлопывать не во что: заголовок первый и не удаляется —
    // браузер сам ничего не сделает, гасить нечего.
  }

  function onChange(text: Span[], _caret: number, kind?: UpdateKind) {
    // Лимит заголовка (200 рун) — единственный лимит схемы, до которого доезжает сам
    // редактор. Без проверки здесь перебор уехал бы в автосейв и вернулся оттуда
    // «ошибкой сохранения» — без причины и без указания, какая правка её вызвала
    // (тот же приём, что у MAX_SPANS в RichLine).
    if ([...plainText(text)].length > MAX_FORM_TITLE_LEN) return
    updateBlock(block.id, { text }, kind)
  }

  return (
    // group — именованная Tailwind-группа строки, relative — якорь absolute-контролов
    // (в поток строки не кладём ничего, урок TD-22). Чипов подсказок здесь больше нет:
    // с 2026-07-29 карта клавиш живёт только в шпаргалке Mod+/, а единственный
    // оставшийся чип (дать полю заголовок) заголовку формы не адресован.
    <div className="group relative">
      <RichLine
        elRef={(el) => {
          ref.current = el
        }}
        value={block.text ?? []}
        placeholder="Название формы"
        label="Название формы"
        // Набор служебных классов — ровно тот же, что у строк BlockRow: RichLine
        // кладёт className прямо на contenteditable и своего сброса не делает, а без
        // outline-none браузер рисует вокруг заголовка дефолтную рамку фокуса (и
        // рисует сразу — эта строка получает фокус при заходе на форму).
        // Плейсхолдер тут атрибутом не задаётся: у contenteditable его нет, надпись
        // рисует правило [data-rich-line]:empty::before в richLine.css.
        className="block w-full bg-transparent outline-none rf-title"
        // Заголовок формы набирается жирным. Спрашиваем реестр тем же вопросом, что и
        // строки BlockRow (у form_title своей строки в реестре нет, и ответ на этот
        // вопрос там особый — см. textIsBold).
        defaultMarks={textIsBold(block.type) ? BOLD_MARKS : undefined}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onFocus={rowFocus.onFocus}
        onBlur={rowFocus.onBlur}
      />
    </div>
  )
}
