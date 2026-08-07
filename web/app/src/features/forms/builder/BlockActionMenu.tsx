import { useState, type ReactNode } from 'react'
import { Copy, GitBranch, Replace, Trash2 } from 'lucide-react'
import {
  MAX_QUESTION_NAME_LEN,
  isAnswerableType,
  isCaptionType,
  type Block,
} from '@entities/formSchema'
import { BLOCK_GROUP_LABELS, BLOCK_GROUP_ORDER, MENU_ITEMS, type MenuItem } from './blockTypes'
import { JumpDialog } from './logic/JumpDialog'
import { BlockRuleDialog } from './logic/LogicDialog'
import {
  type RequiredMode,
  jumpSummary,
  requiredMode,
  requiredPatch,
  ruleCarrier,
  ruleSummary,
} from './logic/model'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { derivedQuestionName } from './questionName'
import { useBuilderStore } from './storeContext'
import { editorKind } from './kinds/index'
import { SettingRow, TextSetting } from './kinds/settings'
import { typeIcon } from './blockTypeIcons'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'

// BlockActionMenu — меню действий блока (Cmd+. §3.3). Маленький поповер у строки,
// Command-список как у слеш-меню — закрывает клавиатурные пробелы, для которых нет
// отдельных шорткатов: обязательность (мышью доступна только через звёздочку),
// дублирование (в сторе есть, UI не было), удаление, смена типа. Пункта ширины здесь
// НЕТ и не будет (спека §5, фаза 13.6): половинность не переключается, она возникает
// от соседства — вход только жест и Mod+Alt+←/→. Два вида в одном поповере:
// «действия» и подменю «сменить тип» (тот же список типов, что «+»-диалог и слеш-меню).
// QuestionNameSetting — имя вопроса: строка, которой он назовётся в данных (колонка
// CSV, шаг воронки, ключ сводки). Поле пусто — в плейсхолдере стоит выведенное имя,
// то есть буквально то, что уйдёт в выгрузку, если ничего не вводить (ADR §10,
// решение 3: имя — переопределение, а не копия заголовка).
//
// Пустая строка кладётся как отсутствие ключа: канон не хранит «имя = ничего», и
// стёртое до конца имя обязано вернуть форму ровно в то состояние, в котором она была
// до ввода, — иначе автосейв возил бы пустой ключ, а Go его всё равно выбрасывал бы.
function QuestionNameSetting({ block }: { block: Block }) {
  const blocks = useBuilderStore((s) => s.blocks)
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  return (
    <TextSetting
      label="Имя"
      value={block.name ?? ''}
      placeholder={derivedQuestionName(blocks, block)}
      maxLength={MAX_QUESTION_NAME_LEN}
      onChange={(v) => updateBlock(block.id, { name: v === '' ? undefined : v })}
    />
  )
}

// RequiredSetting — обязательность ТРЕМЯ состояниями (фаза 21, ADR §10): нет / всегда /
// по условию. Не два флага и не чекбокс с довеском: required и requiredIf схема
// запрещает вместе, и переключатель, из которого невыразимо «ни то ни другое», рано или
// поздно соберёт документ, который сервер отвергнет.
//
// «По условию» открывает диалог, а не пишет что-то само: правило без единого условия
// невалидно, и «обязателен по пустому условию» ничего не значит. Пока автор не выбрал
// условие, режим остаётся прежним.
function RequiredSetting({ block, onCondition }: { block: Block; onCondition: () => void }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const mode = requiredMode(block)
  const pick = (next: RequiredMode) => {
    if (next === 'conditional') {
      onCondition()
      return
    }
    updateBlock(block.id, requiredPatch(next))
  }
  return (
    <SettingRow label="Обязательный">
      <Select value={mode} onValueChange={(v) => pick(v as RequiredMode)}>
        <SelectTrigger size="sm" className="h-7 w-36" aria-label="Обязательность вопроса">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="no">Нет</SelectItem>
          <SelectItem value="always">Всегда</SelectItem>
          <SelectItem value="conditional">По условию…</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>
  )
}

// Стабильная пустота для закрытого попапа: новый литерал на каждый рендер сам был бы
// сменой значения и перерисовывал бы строку.
const NO_BLOCKS: Block[] = []

export function BlockActionMenu({
  open,
  onOpenChange,
  block,
  subject,
  anchor,
  requiredFor,
  onDuplicate,
  onDelete,
  onPickType,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  block: Block
  // subject — СУБЪЕКТ НАСТРОЕК (§4.2 спеки фазы 16): блок, чьи свойства правит попап.
  // У подписи собранного вопроса это его поле, у прочих строк — они сами. Общие
  // пункты остаются у block: на подписи «удалить» значит «удалить вопрос».
  subject: Block
  // anchor — элемент, к которому Radix привязывает поповер (позиционированный span
  // в absolute-поле строки); asChild измеряет его.
  anchor: ReactNode
  // requiredFor — блок, чью обязательность правит пункт меню (см. BlockRow): у поля
  // это оно само, у подписи — поле её вопроса, у контента — ничего, и пункта нет.
  requiredFor?: Block
  onDuplicate: () => void
  onDelete: () => void
  onPickType: (item: MenuItem) => void
}) {
  // Какой вид показан: действия или выбор нового типа. Сбрасывается на «действия»
  // при закрытии, чтобы следующее открытие начиналось с корня.
  const [view, setView] = useState<'actions' | 'types'>('actions')
  // Диалог логики (фаза 21) — рядом с попапом, а не внутри: у правила дерево с
  // группами, попап шириной в одну строку настройки для него мал.
  // Какое правило правим — или null, если диалог закрыт. Одно состояние на оба: диалог
  // у них общий, отличаются только тексты.
  const [logicField, setLogicField] = useState<'visibleIf' | 'requiredIf' | null>(null)
  // Переходы (слайс 5) — свой диалог: у них не одно правило, а список со своим порядком
  // приоритета и целью у каждого.
  const [jumpsOpen, setJumpsOpen] = useState(false)
  // Носитель правила — голова группы: прячется вопрос целиком, а не одна его строка.
  // У заголовка формы правил не бывает — он скелет документа, не вопрос.
  //
  // ПОДПИСКА НА blocks — ТОЛЬКО КОГДА ПОПАП ОТКРЫТ, и это не микрооптимизация. Попап
  // отрисован у КАЖДОЙ строки полотна, а массив блоков меняет идентичность на каждое
  // нажатие клавиши: подписка «всегда» перерисовывала все строки мимо memo и удвоила
  // стоимость символа (замер: 8.8 → 13.4 мс/символ на 13 блоках, 16.7 → 30.9 на 199).
  // Тот же класс, что записан в STATUS про useSortable: дорогое живёт там, где его
  // видит только открытый попап. Закрытый селектор отдаёт стабильную пустоту и не
  // перерисовывает ничего.
  const blocks = useBuilderStore((s) =>
    open || logicField !== null || jumpsOpen ? s.blocks : NO_BLOCKS,
  )
  const carrier = ruleCarrier(blocks, block.id)
  const logicAllowed =
    carrier !== null && carrier.type !== 'form_title' && block.type !== 'page_break'
  // Переходы задаются только у разрыва страницы: правило «куда уходим» принадлежит
  // границе, а не элементу (схема это и проверяет).
  const jumpsAllowed = block.type === 'page_break'
  const isGroup = isCaptionType(block.type)
  // Имя — свойство любого отвечаемого блока, а не типа (ADR §10), поэтому строка общая
  // и стоит выше типового раздела. У подписи, контента и заголовка формы её нет: имя
  // называет колонку выгрузки, а её у них не бывает — схема имя у них и запрещает.
  const named = isAnswerableType(subject.type)
  // Типовой раздел объявляет САМ ТИП (kinds/<type>.tsx, поле Settings). Нет раздела —
  // нет и разделителя: попап показывает одни общие пункты (§4.3 спеки).
  const Settings = editorKind(subject.type).Settings

  const close = () => {
    setView('actions')
    onOpenChange(false)
  }

  return (
    <>
      {/* Носитель у правил РАЗНЫЙ: видимость прячет вопрос целиком (голова группы),
          обязательность — свойство поля (сам отвечаемый блок). */}
      {logicField !== null && (
        <BlockRuleDialog
          open
          onOpenChange={(o) => !o && setLogicField(null)}
          carrier={logicField === 'visibleIf' ? carrier! : requiredFor!}
          kind={logicField}
        />
      )}
      {/* Тоже только открытым: JumpDialog подписан на blocks, а строка-разрыв есть у
          каждой страницы формы. */}
      {jumpsAllowed && jumpsOpen && <JumpDialog open onOpenChange={setJumpsOpen} block={block} />}
      <Popover
        open={open}
        onOpenChange={(o) => {
          if (!o) setView('actions')
          onOpenChange(o)
        }}
      >
        <PopoverAnchor asChild>{anchor}</PopoverAnchor>
        <PopoverContent
          className="w-60 p-0"
          align="start"
          side="bottom"
          // Фокус после действия ставит фокус-движок/само действие; возврат Radix на
          // якорь (позиционированный span) глушим — иначе каретка падает в body.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {view === 'actions' ? (
            <>
              {/* Настройки стоят ВЫШЕ общих пунктов и ВНЕ Command: cmdk перехватывает
                стрелки и Enter для навигации по пунктам, а внутри раздела те же клавиши
                принадлежат контролам (набор текста, открыть список, выбрать значение). */}
              {(named || Settings || requiredFor) && (
                <div className="border-b py-1">
                  {named && <QuestionNameSetting block={subject} />}
                  {requiredFor && (
                    <RequiredSetting
                      block={requiredFor}
                      onCondition={() => {
                        onOpenChange(false)
                        setLogicField('requiredIf')
                      }}
                    />
                  )}
                  {Settings && <Settings block={subject} />}
                </div>
              )}
              <Command>
                <CommandList>
                  <CommandGroup>
                    {logicAllowed && (
                      <CommandItem
                        onSelect={() => {
                          setLogicField('visibleIf')
                          onOpenChange(false)
                        }}
                      >
                        <GitBranch className="size-4" />
                        Показывать: {ruleSummary(blocks, carrier.visibleIf)}
                      </CommandItem>
                    )}
                    {jumpsAllowed && (
                      <CommandItem
                        onSelect={() => {
                          setJumpsOpen(true)
                          onOpenChange(false)
                        }}
                      >
                        <GitBranch className="size-4" />
                        Переходы: {jumpSummary(blocks, block)}
                      </CommandItem>
                    )}
                    <CommandItem onSelect={() => setView('types')}>
                      <Replace className="size-4" />
                      Сменить тип
                    </CommandItem>
                    <CommandItem
                      onSelect={() => {
                        onDuplicate()
                        close()
                      }}
                    >
                      <Copy className="size-4" />
                      Дублировать
                    </CommandItem>
                    <CommandItem
                      onSelect={() => {
                        onDelete()
                        close()
                      }}
                    >
                      <Trash2 className="size-4" />
                      {isGroup ? 'Удалить вопрос' : 'Удалить блок'}
                    </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </>
          ) : (
            <Command>
              <CommandInput placeholder="Тип поля…" />
              <CommandList>
                <CommandEmpty>Ничего не найдено</CommandEmpty>
                {BLOCK_GROUP_ORDER.map((g) => (
                  <CommandGroup key={g} heading={BLOCK_GROUP_LABELS[g]}>
                    {MENU_ITEMS.filter((t) => t.group === g).map((t) => (
                      <CommandItem
                        key={t.key}
                        value={`${t.label} ${t.key}`}
                        onSelect={() => {
                          onPickType(t)
                          close()
                        }}
                      >
                        {typeIcon(t.type)}
                        {t.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          )}
        </PopoverContent>
      </Popover>
    </>
  )
}
