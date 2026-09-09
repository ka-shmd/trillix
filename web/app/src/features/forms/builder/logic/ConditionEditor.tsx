import { ChevronDown, Copy, Plus, Repeat, Trash2 } from 'lucide-react'
import { useState } from 'react'

import {
  type Block,
  type LogicCondition,
  type LogicOperator,
  MAX_LOGIC_DEPTH,
  MAX_LOGIC_VALUE_LEN,
  opNeedsValue,
} from '@entities/formSchema'
import { operatorsFor } from '@fields/logic'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { GlyphName } from '../GlyphName'
import {
  type Group,
  defaultLeaf,
  operatorLabel,
  referenceSources,
  sourceLabel,
  valueChoices,
  valueInputType,
} from './model'
import { RowMenu as RowMenuButton } from './rowMenu'

// Редактор дерева условий. Рекурсивный: группа рисует своих детей тем же компонентом,
// поэтому вложенность «(А и Б) или В» не стоит ни одной особой ветки.
//
// Инвариант формы, который держит редактор: КОРЕНЬ ВСЕГДА ГРУППА. Схема принимает и
// одинокий лист, но два способа выразить одно правило означали бы две ветки в каждой
// операции редактора («а если корень лист — сперва заверни»). Группа из одного условия
// валидна и выглядит ровно как одно условие.
//
// ВСЁ УПРАВЛЕНИЕ ЖИВЁТ В МЕНЮ СТРОКИ (решение владельца 2026-08-16). Кнопок «+ Условие»
// и «+ Группа» под деревом больше нет, крестика в конце строки — тоже: четыре операции
// уехали в один значок после контрола значения — добавить, удалить, дублировать,
// обернуть в группу (состав и порядок взяты у Tally, образца вида полотна). Причина не
// в экономии места: строка условия — самостоятельная единица, и держать её операции в
// двух разных местах (хвост строки и подвал дерева) значит заставлять глаз прыгать
// между ними на каждое действие.
//
// ГРУППА — ТАКОЙ ЖЕ РЕБЁНОК своего родителя, что и лист, поэтому меню у неё то же самое
// и стоит в её шапке. Отдельной механики «удалить группу» нет и не нужно: пункты
// работают над узлом, а какой это узел — лист или группа — их не касается.
//
// Связка «все/любое» показывается, ТОЛЬКО когда условий больше одного: у единственного
// условия связывать нечего, а выбор, который ничего не меняет, читается как забытая
// настройка. И выглядит она текстом с шевроном, а не полем ввода, — это подпись
// отношения между строками, а не значение, которое автор задаёт.

// Ширина контрола строки: фиксированная, а не «во всю оставшуюся» (решение владельца
// 2026-08-16). Растянутый на пол-полотна выпадающий список читается как поле ввода, а
// длинное имя вопроса всё равно не помещается целиком — его обрезает многоточие.
// `max-w-full` оставлен, чтобы на узком полотне контрол не выпирал за край.
//
// МНОГОТОЧИЕ, А НЕ ОБРЕЗКА ПО ЖИВОМУ. Три класса, и ни один не лишний:
//
//   • `block` ПЕРЕБИВАЕТ `flex`, который shadcn ставит слоту значения. На флекс-
//     контейнере `text-overflow` не действует вовсе — текст клипается по границе, ровно
//     посреди буквы;
//   • `min-w-0` — слот лежит внутри флекса-триггера, а флекс-элемент по умолчанию не
//     сжимается уже своего содержимого, и обрезать было бы нечего;
//   • `truncate` — собственно `overflow:hidden` + `ellipsis` + `nowrap`.
//
// Все три объявлены ТЕМ ЖЕ вариантом, что и перебиваемое (`*:data-[slot=select-value]:`),
// иначе tailwind-merge их не сольёт и победит порядок в собранном CSS, а не в строке
// (web/CLAUDE.md). Проверяется только computed-стилем.
const TRUNCATE =
  '*:data-[slot=select-value]:block *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate'
// Источник — единственный контрол строки, чьё значение НЕ голый текст: рядом с именем
// вопроса стоит глиф его типа (GlyphName). Поэтому и обрезка у него своя: флекс слота
// значения не перебивается (на нём держится просвет глиф→имя), многоточие ставит сам
// GlyphName, а слоту остаётся разрешение сжиматься.
const SOURCE = 'h-7 w-56 max-w-full *:data-[slot=select-value]:min-w-0'
const OPERATOR = `h-7 w-36 max-w-full ${TRUNCATE}`
const VALUE = `h-7 w-44 max-w-full ${TRUNCATE}`

const childrenOf = (g: Group): LogicCondition[] => ('all' in g ? g.all : g.any)
const isAnd = (g: Group): boolean => 'all' in g
const asGroup = (children: LogicCondition[], and: boolean): Group =>
  and ? { all: children } : { any: children }

type Leaf = { blockId: string; op: LogicOperator; value?: string; valueRef?: string }

const isLeaf = (c: LogicCondition): c is Leaf => !('all' in c) && !('any' in c)

// Связка «все/любое» — ТЕКСТ с шевроном, а не поле ввода: это подпись отношения между
// строками, а не значение, которое автор задаёт. Показывается, только когда условий
// больше одного: у единственного связывать нечего.
//
// МИНА: рамка, фон, тень и высота гасятся ТЕМИ ЖЕ вариантами, которыми объявлены в
// SelectTrigger (`data-[size=sm]`, `dark:`). Напишешь голый `h-auto` — tailwind-merge их
// не сольёт, и победит тот класс, что позже в собранном CSS, а не в строке `className`
// (web/CLAUDE.md); проверяется только computed-стилем.
export function JoinSelect({ value, onChange }: { value: Group; onChange: (next: Group) => void }) {
  const children = childrenOf(value)
  if (children.length <= 1) return null
  const and = isAnd(value)
  return (
    <Select
      value={and ? 'all' : 'any'}
      onValueChange={(v) => onChange(asGroup(children, v === 'all'))}
    >
      <SelectTrigger
        size="sm"
        className="h-auto w-auto gap-1 border-0 bg-transparent p-0 text-xs tracking-wide text-muted-foreground uppercase shadow-none data-[size=sm]:h-auto hover:text-foreground focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent"
        aria-label="Как объединять условия"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Все условия</SelectItem>
        <SelectItem value="any">Любое из условий</SelectItem>
      </SelectContent>
    </Select>
  )
}

export function ConditionEditor({
  blocks,
  sources,
  value,
  depth = 1,
  menu,
  onChange,
  onRemove,
}: {
  blocks: readonly Block[]
  // Источники — отвечаемые вопросы выше блока (sourcesFor). Считаются один раз наверху
  // и раздаются вниз: список одинаков для всего дерева.
  sources: readonly Block[]
  value: Group
  depth?: number
  // Меню операций НАД САМОЙ группой: она такой же ребёнок своего родителя, что и лист,
  // и операции у неё те же — добавить рядом, удалить, дублировать, обернуть. Нет меню —
  // это корень: удалять и дублировать его некому.
  menu?: RowMenu
  onChange: (next: Group) => void
  onRemove?: () => void
}) {
  const children = childrenOf(value)
  const and = isAnd(value)
  // Связку корня рисует ЯРУС «Когда» (она стоит в одной строке с его подписью), поэтому
  // здесь она только у вложенных групп — у них своей подписи нет.
  const showJoin = depth > 1 && children.length > 1

  const replaceChild = (i: number, next: LogicCondition | null): void => {
    const rest = children.filter((_, j) => j !== i)
    if (next === null) {
      // Группа без условий невалидна по схеме, и это не формальность: правило,
      // которое ничего не проверяет, неотличимо от отсутствующего. Пустую группу
      // редактор просто убирает целиком — вместе с последним условием внутри неё.
      if (rest.length === 0) {
        onRemove?.()
        return
      }
      onChange(asGroup(rest, and))
      return
    }
    onChange(
      asGroup(
        children.map((c, j) => (j === i ? next : c)),
        and,
      ),
    )
  }

  const insertAfter = (i: number, node: LogicCondition): void => {
    onChange(asGroup([...children.slice(0, i + 1), node, ...children.slice(i + 1)], and))
  }

  const rowMenu = (i: number, child: LogicCondition): RowMenu => ({
    // Новое условие берёт первый доступный источник: выбирать «ничего» в списке
    // источников нельзя, а пустой blockId схема отвергает.
    onAdd: sources[0] ? () => insertAfter(i, defaultLeaf(sources[0]!)) : undefined,
    onRemove: () => replaceChild(i, null),
    onDuplicate: () => insertAfter(i, child),
    // ОБЕРНУТЬ, а не «добавить группу ниже»: условие остаётся на месте и получает
    // вокруг себя группу, в которую дальше можно доложить соседей. Глубже лимита схемы
    // пункт не показываем — 422 в автосейве от нажатия собственной кнопки худший способ
    // узнать про лимит.
    onWrap: depth < MAX_LOGIC_DEPTH ? () => replaceChild(i, { all: [child] }) : undefined,
  })

  return (
    <div
      className={depth > 1 ? 'border-muted space-y-2 rounded-md border-l-2 py-2 pl-3' : 'space-y-2'}
    >
      {(showJoin || menu) && (
        <div className="flex items-center gap-1">
          {showJoin && <JoinSelect value={value} onChange={onChange} />}
          {menu && <RowActions menu={menu} />}
        </div>
      )}

      {children.map((child, i) => {
        const key = `${i}`
        if (!isLeaf(child)) {
          return (
            <ConditionEditor
              key={key}
              blocks={blocks}
              sources={sources}
              value={child}
              depth={depth + 1}
              menu={rowMenu(i, child)}
              onChange={(next) => replaceChild(i, next)}
              onRemove={() => replaceChild(i, null)}
            />
          )
        }
        return (
          <LeafRow
            key={key}
            blocks={blocks}
            sources={sources}
            value={child}
            onChange={(next) => replaceChild(i, next)}
            menu={rowMenu(i, child)}
          />
        )
      })}

      {/* Пустое дерево рисуется ОДНОЙ незаполненной строкой, а не кнопкой «добавить»:
          иначе, сняв кнопки, автор остался бы без входа в правило вовсе. Строка
          попадает в документ в тот момент, когда выбран источник, — до него хранить
          нечего (пустой blockId схема отвергает). */}
      {children.length === 0 && (
        <LeafRow
          blocks={blocks}
          sources={sources}
          value={null}
          onChange={(next) => onChange(asGroup([next], and))}
          // Меню есть и здесь: второе условие добавляется, пока первое ещё не выбрано.
          menu={
            sources[0]
              ? { onAdd: () => onChange(asGroup([defaultLeaf(sources[0]!)], and)) }
              : undefined
          }
        />
      )}
    </div>
  )
}

// Пункты по отдельности необязательны: у незаполненной строки нечего удалять,
// дублировать и оборачивать — у неё есть только «добавить».
type RowMenu = {
  onAdd?: () => void
  onRemove?: () => void
  onDuplicate?: () => void
  onWrap?: () => void
}

// Лист: «вопрос — сравнение — значение» и меню операций.
//
// ТРИ КОНТРОЛА СТОЯТ ВСЕГДА, даже когда вопрос ещё не выбран (решение владельца
// 2026-08-16): строка не должна перестраиваться под курсором, пока автор её заполняет.
// Пустые контролы выключены — выбирать в них нечего, пока нет источника. Исключение
// одно: у «отвечен»/«не отвечен» значения нет вовсе, и третий контрол у них не
// выключается, а исчезает — это не «ещё не выбрано», а «не бывает».
function LeafRow({
  blocks,
  sources,
  value,
  onChange,
  menu,
}: {
  blocks: readonly Block[]
  sources: readonly Block[]
  value: Leaf | null
  onChange: (next: LogicCondition) => void
  menu?: RowMenu
}) {
  const source = value ? blocks.find((b) => b.id === value.blockId) : undefined
  const ops = source ? operatorsFor(source.type) : []
  const choices = source ? valueChoices(source) : []
  // Есть ли на форме вопросы, чей ответ годится правой частью. Нет — контрол значения
  // остаётся тем же, чем был: список вариантов либо строка ввода.
  const refs = source ? referenceSources(blocks, source) : []
  // Чем значение вводится: у даты — календарём браузера, у числа — числовым полем.
  const inputType = source ? valueInputType(source) : 'text'
  const needsValue = value === null || opNeedsValue(value.op)

  // Смена источника роняет оператор и значение, если они ему не подходят: id варианта
  // от прошлого списка в новом не значит ничего, а несовместимый оператор сделал бы
  // правило инертным молча.
  const pickSource = (id: string): void => {
    const next = blocks.find((b) => b.id === id)
    if (!next) return
    onChange(
      value && operatorsFor(next.type).includes(value.op)
        ? { ...defaultLeaf(next), op: value.op }
        : defaultLeaf(next),
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={source ? source.id : ''} onValueChange={pickSource}>
        <SelectTrigger size="sm" className={SOURCE} aria-label="Вопрос-источник">
          <SelectValue placeholder={value === null ? 'Вопрос…' : 'Удалённый вопрос'} />
        </SelectTrigger>
        <SelectContent>
          {sources.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {/* Источник — всегда отвечаемый блок (logicSources), то есть инпут своего
                  вопроса: глиф его типа и есть глиф вопроса. */}
              <GlyphName type={b.type}>{sourceLabel(blocks, b)}</GlyphName>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        disabled={value === null}
        value={value?.op ?? ''}
        onValueChange={(op) =>
          value !== null &&
          onChange({
            blockId: value.blockId,
            op: op as LogicOperator,
            // «отвечен»/«не отвечен» правой части не несут — схема отвергает у них и
            // значение, и ссылку, поэтому роняем их здесь, а не ловим 422 автосейвом.
            ...(opNeedsValue(op as LogicOperator) && value.value ? { value: value.value } : {}),
            ...(opNeedsValue(op as LogicOperator) && value.valueRef
              ? { valueRef: value.valueRef }
              : {}),
          })
        }
      >
        <SelectTrigger size="sm" className={OPERATOR} aria-label="Сравнение">
          <SelectValue placeholder="Сравнение" />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op}>
              {operatorLabel(op, source?.type)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {needsValue &&
        (value !== null && refs.length > 0 ? (
          <ValuePicker
            blocks={blocks}
            value={value}
            choices={choices}
            refs={refs}
            inputType={inputType}
            onChange={onChange}
          />
        ) : value !== null && choices.length > 0 ? (
          <Select value={value.value ?? ''} onValueChange={(v) => onChange({ ...value, value: v })}>
            <SelectTrigger size="sm" className={VALUE} aria-label="Значение">
              <SelectValue placeholder="Значение…" />
            </SelectTrigger>
            <SelectContent>
              {choices.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            className="h-7 w-44 max-w-full text-sm"
            type={inputType}
            disabled={value === null}
            value={value?.value ?? ''}
            placeholder="Значение…"
            aria-label="Значение"
            // Потолок ровно тот, что у схемы: без него вставка длинной строки роняла
            // автосейв в 422 и черновик перестал бы сохраняться, а сообщения про лимит
            // автор не видит нигде. То же правило, по которому ограничено имя вопроса.
            maxLength={MAX_LOGIC_VALUE_LEN}
            onChange={(e) =>
              value !== null &&
              onChange(
                e.target.value === ''
                  ? { blockId: value.blockId, op: value.op }
                  : { ...value, value: e.target.value },
              )
            }
          />
        ))}

      {menu && <RowActions menu={menu} />}
    </div>
  )
}

// ЗНАЧЕНИЕ ИЛИ ОТВЕТ ДРУГОГО ВОПРОСА — один контрол с двумя разделами (решение
// владельца 2026-09-09). Правая часть условия перестала быть только литералом: с ней
// сравнивают и ответ другого вопроса («бюджет больше, чем стоимость»). Что с чем
// сравнимо, решает вычислитель (`canReferenceAnswer` через `referenceSources`), а не
// этот файл: список и семантика обязаны говорить одно и то же.
//
// Контрол ОДИН, а не поле плюс тумблер: правая часть — одна мысль автора, и разводить
// её по двум местам значит спрашивать «литерал или ссылка?» раньше, чем автор решил,
// что он вообще сравнивает. Разделов в списке два — «Значение» и «Ответ на вопрос».
//
// Список источников контрол НЕ сужает позицией (ссылка ниже цели инертна, но законна) —
// негодную пару называет предупреждение блока, как и у самого источника.
//
// СТРОКА ПОИСКА ЗДЕСЬ ЖЕ И СТРОКА ВВОДА, и у свободного ввода она пишет в документ ПО
// БУКВЕ, а не по Enter. Иначе набранное «до 18» терялось бы от клика мимо попапа — это
// поле ввода значения, и вести себя оно должно как поле ввода. Там, где список закрыт
// (шкала), ввод остаётся поиском: значением бывает только пункт списка.
function ValuePicker({
  blocks,
  value,
  choices,
  refs,
  inputType,
  onChange,
}: {
  blocks: readonly Block[]
  value: Leaf
  choices: { value: string; label: string }[]
  refs: readonly Block[]
  inputType: 'date' | 'number' | 'text'
  onChange: (next: LogicCondition) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = value.valueRef ? blocks.find((b) => b.id === value.valueRef) : undefined

  const leafWith = (rest: Partial<Leaf>): LogicCondition => ({
    blockId: value.blockId,
    op: value.op,
    ...rest,
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="Значение"
          className={`${VALUE} justify-between font-normal`}
        >
          <ValueSummary blocks={blocks} value={value} choices={choices} refBlock={ref} />
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <Section title="Значение">
          {choices.length > 0 ? (
            choices.map((c) => (
              <PickerRow
                key={c.value}
                selected={value.value === c.value}
                onSelect={() => {
                  onChange(leafWith({ value: c.value }))
                  setOpen(false)
                }}
              >
                {c.label}
              </PickerRow>
            ))
          ) : (
            <Input
              className="h-7 text-sm"
              type={inputType}
              autoFocus
              value={value.value ?? ''}
              placeholder="Значение…"
              aria-label="Значение условия"
              // Потолок ровно тот, что у схемы: без него вставка длинной строки роняла
              // бы автосейв в 422, а сообщения про лимит автор не видит нигде.
              maxLength={MAX_LOGIC_VALUE_LEN}
              // Пишем ПО БУКВЕ, как в обычном поле: попап не диалог с кнопкой «ОК», и
              // набранное не должно теряться от клика мимо. Ввод гасит ссылку — правая
              // часть одна, и две сразу схема отвергает.
              onChange={(e) =>
                onChange(leafWith(e.target.value === '' ? {} : { value: e.target.value }))
              }
            />
          )}
        </Section>

        <Section title="Ответ на вопрос">
          {refs.map((b) => (
            <PickerRow
              key={b.id}
              selected={value.valueRef === b.id}
              onSelect={() => {
                onChange(leafWith({ valueRef: b.id }))
                setOpen(false)
              }}
            >
              <GlyphName type={b.type}>{sourceLabel(blocks, b)}</GlyphName>
            </PickerRow>
          ))}
        </Section>
      </PopoverContent>
    </Popover>
  )
}

// Раздел попапа: подпись и содержимое. Подписи здесь несут смысл — без них список
// вопросов читается как продолжение списка значений.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 py-1">
      <div className="text-muted-foreground px-2 text-xs font-medium">{title}</div>
      {children}
    </div>
  )
}

// Строка выбора. Кнопка, а не CommandItem: список короткий (сравнимые вопросы одного
// домена да варианты одного списка), поиск ему не нужен, а cmdk забрал бы у поля ввода
// стрелки и Enter — то есть у ТОГО контрола, ради которого попап и открывают.
function PickerRow({
  selected,
  onSelect,
  children,
}: {
  selected: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-accent ${
        selected ? 'bg-accent' : ''
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  )
}

// Что написано на контроле. Ссылка называется вопросом с глифом его типа — тем же, чем
// вопрос зовётся в списке источников; удалённая ссылка остаётся видимой словами, а не
// пустотой, иначе правило выглядело бы недозаполненным.
function ValueSummary({
  blocks,
  value,
  choices,
  refBlock,
}: {
  blocks: readonly Block[]
  value: Leaf
  choices: { value: string; label: string }[]
  refBlock: Block | undefined
}) {
  if (value.valueRef !== undefined) {
    return refBlock ? (
      <GlyphName type={refBlock.type}>{sourceLabel(blocks, refBlock)}</GlyphName>
    ) : (
      <span className="min-w-0 truncate">Удалённый вопрос</span>
    )
  }
  const literal = value.value ?? ''
  if (literal === '')
    return <span className="text-muted-foreground min-w-0 truncate">Значение…</span>
  const label = choices.find((c) => c.value === literal)?.label ?? literal
  return <span className="min-w-0 truncate">{label}</span>
}

// Меню операций строки. Состав и порядок пунктов взяты у Tally (образец вида полотна,
// `fields/README.md`): добавить, удалить, дублировать, обернуть в группу. Сам значок и
// его положение — общий `RowMenu`, тот же, что у яруса действий.
function RowActions({ menu }: { menu: RowMenu }) {
  return (
    <RowMenuButton
      label="Действия с условием"
      items={[
        ...(menu.onAdd ? [{ icon: Plus, label: 'Добавить условие', onSelect: menu.onAdd }] : []),
        ...(menu.onRemove ? [{ icon: Trash2, label: 'Удалить', onSelect: menu.onRemove }] : []),
        ...(menu.onDuplicate
          ? [{ icon: Copy, label: 'Дублировать', onSelect: menu.onDuplicate }]
          : []),
        ...(menu.onWrap
          ? [{ icon: Repeat, label: 'Обернуть в группу', onSelect: menu.onWrap }]
          : []),
      ]}
    />
  )
}
