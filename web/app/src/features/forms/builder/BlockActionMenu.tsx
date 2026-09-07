import { useState, type ReactNode } from 'react'
import { Copy, Replace, Trash2 } from 'lucide-react'
import {
  BLOCK_CLASS_RE,
  MAX_BLOCK_CLASS_LEN,
  MAX_QUESTION_NAME_LEN,
  isAnswerableType,
  isCaptionType,
  type Block,
} from '@entities/formSchema'
import { BLOCK_GROUP_LABELS, BLOCK_GROUP_ORDER, MENU_ITEMS, type MenuItem } from './blockTypes'
import { ChordChips } from './ChordChips'
import { chords, labelFor, type KeyLike } from './shortcuts'
import { Switch } from '@/components/ui/switch'
import { derivedQuestionName } from './questionName'
import { useBuilderStore } from './storeContext'
import { editorKind } from './kinds/index'
import { SettingRow, TextSetting } from './kinds/settings'
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

// ClassSetting — СВОЁ ИМЯ БЛОКА для CSS автора (фаза 22, слайс 7). Стоит здесь, а не
// в шторке «Оформление», по той же причине, по какой там стоит имя вопроса: это
// свойство ЭТОГО блока, и задаётся оно там, где на блок смотрят.
//
// Показывается всегда, а не только на платном тарифе: пометить блок можно и не имея
// CSS — гейт стоит на публикации формы С правилами, а не на самой пометке. Пустая
// строка кладётся отсутствием ключа, как и имя вопроса.
//
// Ввод НЕ фильтруется на лету (только maxLength): вычищать заглавные и пробелы прямо
// под курсором значит драться с автором посреди слова. Невалидное имя краснеет
// подсказкой, а автосейв его не отправляет — иначе схема ловила бы 422 на каждой
// промежуточной букве.
function ClassSetting({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? block.class ?? ''
  const invalid = value !== '' && !BLOCK_CLASS_RE.test(value)
  return (
    <>
      <TextSetting
        label="Имя для CSS"
        value={value}
        placeholder="promo-block"
        maxLength={MAX_BLOCK_CLASS_LEN}
        onChange={(v) => {
          setDraft(v)
          if (v === '') updateBlock(block.id, { class: undefined })
          else if (BLOCK_CLASS_RE.test(v)) updateBlock(block.id, { class: v })
        }}
      />
      {invalid && (
        <p className="text-muted-foreground px-2 pb-1 text-xs">
          Строчные латинские буквы, цифры и дефис — например <code>promo-block</code>.
        </p>
      )}
    </>
  )
}

// RequiredSetting — обязательность ТУМБЛЕРОМ: да / нет. Обязательность ПО УСЛОВИЮ —
// не третье его положение и вообще не свойство блока: её задаёт действие «сделать
// обязательным» в блоке `logic` на полотне (ADR §10). Флаг и действие складываются по
// ИЛИ, и о бессмысленной паре («обязателен всегда» плюс условие) предупреждает сам
// блок логики — валидатор здесь бессилен, проверка кросс-блочная.
function RequiredSetting({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  return (
    <SettingRow label="Обязательный">
      <Switch
        checked={block.required === true}
        aria-label="Обязательность вопроса"
        onCheckedChange={(on) => updateBlock(block.id, { required: on })}
      />
    </SettingRow>
  )
}

// ACTION_ITEM — вид пункта действий. Зеркалит вендоренный CommandItem (те же отступы,
// скругление, размер значка), но подсветку даёт ТОЛЬКО настоящее наведение и фокус —
// «выбранного» пункта у обычных кнопок не бывает.
const ACTION_ITEM =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'

// MenuView — какой из двух видов попапа показан. Держит его СТРОКА, а не попап:
// открывающий решает, с чего начать (Alt+R зовёт сразу список типов), а внутреннее
// состояние пришлось бы толкать пропом, меняющимся уже после открытия.
export type MenuView = 'actions' | 'types'

// Chord — клавиши пункта справа от подписи. Ярлык берётся из карты шорткатов по
// матчеру (labelFor), а не пишется здесь строкой: подпись на контроле и обещание
// шпаргалки Mod+/ обязаны совпадать, иначе первая же перевязка жеста сделает попап
// лжецом (демо-критерий 13.5). Нет пункта в карте — нет и клавиш: рисуем пусто.
//
// ⌫-вариант удаления (Mod+Shift+⌫) здесь не печатается намеренно: пункт один, а
// клавиш у него две, и вторая строка чипов в узком пункте читается как отдельное
// действие. Печатается Delete — та, что работает ПРЯМО ЗДЕСЬ, при открытом попапе.
function Chord({ match }: { match: (e: KeyLike) => boolean }) {
  const label = labelFor(match)
  return label ? (
    <span className="ml-auto pl-2">
      <ChordChips label={label} />
    </span>
  ) : null
}

export function BlockActionMenu({
  open,
  onOpenChange,
  block,
  subject,
  anchor,
  requiredFor,
  view,
  onViewChange,
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
  // Какой вид показан. Снаружи, потому что снаружи и решают, с чего открыть: клик по
  // грипу и Mod+. зовут «действия», Alt+R — сразу типы.
  view: MenuView
  onViewChange: (view: MenuView) => void
  onDuplicate: () => void
  onDelete: () => void
  onPickType: (item: MenuItem) => void
}) {
  //
  // ПОДПИСКА НА blocks — ТОЛЬКО КОГДА ПОПАП ОТКРЫТ, и это не микрооптимизация. Попап
  // отрисован у КАЖДОЙ строки полотна, а массив блоков меняет идентичность на каждое
  // нажатие клавиши: подписка «всегда» перерисовывала все строки мимо memo и удвоила
  // стоимость символа (замер: 8.8 → 13.4 мс/символ на 13 блоках, 16.7 → 30.9 на 199).
  // Тот же класс, что записан в STATUS про useSortable: дорогое живёт там, где его
  // видит только открытый попап. Закрытый селектор отдаёт стабильную пустоту и не
  // перерисовывает ничего.
  const isGroup = isCaptionType(block.type)
  // Имя — свойство любого отвечаемого блока, а не типа (ADR §10), поэтому строка общая
  // и стоит выше типового раздела. У подписи, контента и заголовка формы её нет: имя
  // называет колонку выгрузки, а её у них не бывает — схема имя у них и запрещает.
  const named = isAnswerableType(subject.type)
  // Типовой раздел объявляет САМ ТИП (kinds/<type>.tsx, поле Settings). Нет раздела —
  // нет и разделителя: попап показывает одни общие пункты (§4.3 спеки).
  const Settings = editorKind(subject.type).Settings

  const close = () => {
    onViewChange('actions')
    onOpenChange(false)
  }

  // Три действия — одним списком: он же рисует пункты, он же отвечает на аккорды при
  // открытом попапе. Клавиши здесь работают ВСЕГДА, на любой строке, — поэтому чипы у
  // пунктов не врут даже там, где на самом полотне голый Delete занят текстом.
  const actions = [
    {
      key: 'type' as const,
      icon: <Replace className="size-4" />,
      label: 'Сменить тип',
      match: chords.changeType,
      run: () => onViewChange('types'),
    },
    {
      key: 'copy' as const,
      icon: <Copy className="size-4" />,
      label: 'Дублировать',
      match: chords.duplicateBlock,
      run: () => {
        onDuplicate()
        close()
      },
    },
    {
      key: 'trash' as const,
      icon: <Trash2 className="size-4" />,
      label: isGroup ? 'Удалить вопрос' : 'Удалить блок',
      match: chords.deleteKey,
      run: () => {
        onDelete()
        close()
      },
    },
  ]

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(o) => {
          if (!o) onViewChange('actions')
          onOpenChange(o)
        }}
      >
        <PopoverAnchor asChild>{anchor}</PopoverAnchor>
        <PopoverContent
          // Шире прежних 240px: у пунктов появились клавиши справа, и в узкой коробке
          // они наезжали бы на подпись «Удалить вопрос»; 22rem — второй шаг по той же
          // причине (решение владельца 2026-09-07), теперь ещё и ради строк настроек.
          className="w-[22rem] p-0"
          align="start"
          side="bottom"
          // Фокус после действия ставит фокус-движок/само действие; возврат Radix на
          // якорь (позиционированный span) глушим — иначе каретка падает в body.
          onCloseAutoFocus={(e) => e.preventDefault()}
          // Аккорды пунктов при ОТКРЫТОМ попапе. Только в виде «действия»: в списке
          // типов стоит поле поиска, и Delete там принадлежит тексту.
          onKeyDown={(e) => {
            if (view !== 'actions') return
            const hit = actions.find((a) => a.match(e))
            if (!hit) return
            e.preventDefault()
            hit.run()
          }}
        >
          {view === 'actions' ? (
            <>
              {/* Настройки стоят ВЫШЕ общих пунктов и ВНЕ Command: cmdk перехватывает
                стрелки и Enter для навигации по пунктам, а внутри раздела те же клавиши
                принадлежат контролам (набор текста, открыть список, выбрать значение). */}
              {(named || Settings || requiredFor) && (
                <div className="border-b py-1">
                  {named && <QuestionNameSetting block={subject} />}
                  <ClassSetting block={subject} />
                  {requiredFor && <RequiredSetting block={requiredFor} />}
                  {Settings && <Settings block={subject} />}
                </div>
              )}
              {/* ОБЫЧНЫЕ КНОПКИ, А НЕ СПИСОК cmdk (решение владельца 2026-09-07).
                  cmdk всегда держит один пункт «выбранным» и красит его как наведённый —
                  в списке с поиском это курсор клавиатуры, а в трёх статичных действиях
                  читается как «мышь стоит на удалении», хотя мышь в другом углу экрана.
                  Клавиатуре от этого ничего не досталось хуже: по кнопкам ходит Tab, а
                  сами действия висят на аккордах (чипы справа), которые работают в
                  открытом попапе. Поиск и фильтрация нужны только списку ТИПОВ — там
                  cmdk и остался. */}
              <div className="p-1">
                {actions.map((a) => (
                  <button key={a.key} type="button" className={ACTION_ITEM} onClick={a.run}>
                    {a.icon}
                    {a.label}
                    <Chord match={a.match} />
                  </button>
                ))}
              </div>
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
                        {t.icon}
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
