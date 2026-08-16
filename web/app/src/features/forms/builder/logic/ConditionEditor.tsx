import { Copy, EllipsisVertical, Plus, Repeat, Trash2 } from 'lucide-react'

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { type Group, OPERATOR_LABELS, defaultLeaf, sourceLabel, valueChoices } from './model'

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

const childrenOf = (g: Group): LogicCondition[] => ('all' in g ? g.all : g.any)
const isAnd = (g: Group): boolean => 'all' in g
const asGroup = (children: LogicCondition[], and: boolean): Group =>
  and ? { all: children } : { any: children }

type Leaf = { blockId: string; op: LogicOperator; value?: string }

const isLeaf = (c: LogicCondition): c is Leaf => !('all' in c) && !('any' in c)

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
      {(children.length > 1 || menu) && (
        <div className="flex items-center gap-1">
          {children.length > 1 && (
            <Select
              value={and ? 'all' : 'any'}
              onValueChange={(v) => onChange(asGroup(children, v === 'all'))}
            >
              {/* Вид ТЕКСТА, а не поля: рамка, фон, тень и высота гасятся теми же
              вариантами, которыми они объявлены (data-[size=sm], dark:) — иначе
              tailwind-merge их не сольёт и победит тот класс, что позже в собранном
              CSS, а не в строке (web/CLAUDE.md). */}
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
          )}
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
        />
      )}
    </div>
  )
}

type RowMenu = {
  onAdd?: () => void
  onRemove: () => void
  onDuplicate: () => void
  onWrap?: () => void
}

// Лист: «вопрос — сравнение — значение» и меню операций. Значение показывается только у
// операторов, которые сравнивают (у «отвечен» его нет вовсе); у незаполненной строки
// (value === null) нет ни оператора, ни значения — сравнивать ещё нечего.
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
  const needsValue = value !== null && opNeedsValue(value.op)

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
        <SelectTrigger size="sm" className="h-7 min-w-36 flex-1" aria-label="Вопрос-источник">
          <SelectValue placeholder={value === null ? 'Вопрос…' : 'Удалённый вопрос'} />
        </SelectTrigger>
        <SelectContent>
          {sources.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {sourceLabel(blocks, b)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {value !== null && (
        <Select
          value={value.op}
          onValueChange={(op) =>
            onChange({
              blockId: value.blockId,
              op: op as LogicOperator,
              // «отвечен»/«не отвечен» значения не несут — схема непустое value у них
              // отвергает, поэтому роняем его здесь, а не ловим 422 автосейвом.
              ...(opNeedsValue(op as LogicOperator) && value.value ? { value: value.value } : {}),
            })
          }
        >
          <SelectTrigger size="sm" className="h-7 w-32" aria-label="Сравнение">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ops.map((op) => (
              <SelectItem key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {needsValue &&
        value !== null &&
        (choices.length > 0 ? (
          <Select value={value.value ?? ''} onValueChange={(v) => onChange({ ...value, value: v })}>
            <SelectTrigger size="sm" className="h-7 min-w-28 flex-1" aria-label="Значение">
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
            className="h-7 min-w-28 flex-1 text-sm"
            value={value.value ?? ''}
            placeholder="Значение…"
            aria-label="Значение"
            // Потолок ровно тот, что у схемы: без него вставка длинной строки роняла
            // автосейв в 422 и черновик перестал бы сохраняться, а сообщения про лимит
            // автор не видит нигде. То же правило, по которому ограничено имя вопроса.
            maxLength={MAX_LOGIC_VALUE_LEN}
            onChange={(e) =>
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

// Меню операций строки — ПОСЛЕ значения, там, где раньше стоял крестик. Состав и
// порядок пунктов взяты у Tally (образец вида полотна, `fields/README.md`): добавить,
// удалить, дублировать, обернуть в группу.
function RowActions({ menu }: { menu: RowMenu }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Действия с условием"
        >
          <EllipsisVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {menu.onAdd && (
          <DropdownMenuItem onSelect={menu.onAdd}>
            <Plus className="size-4" />
            Добавить условие
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={menu.onRemove}>
          <Trash2 className="size-4" />
          Удалить
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={menu.onDuplicate}>
          <Copy className="size-4" />
          Дублировать
        </DropdownMenuItem>
        {menu.onWrap && (
          <DropdownMenuItem onSelect={menu.onWrap}>
            <Repeat className="size-4" />
            Обернуть в группу
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
