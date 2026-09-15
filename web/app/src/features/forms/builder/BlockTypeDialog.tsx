import { useMemo, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import {
  type Block,
  type BlockType,
  carriesText,
  type FormDesign,
  isChoiceType,
  requiresCaption,
  textFromString,
} from '@entities/formSchema'
import { BlockField } from '@fields/BlockField'
import { SlotStubProvider } from '@fields/booking'
import { designClasses, designToVars } from '@fields/design'
import { groupMeta } from '@fields/groups'
import { SlotStub } from '@fields/slots/SlotStub'
import { groupClass } from '@fields/space'
import { BLOCK_GROUP_LABELS, BLOCK_GROUP_ORDER, MENU_ITEMS, type MenuItem } from './blockTypes'
import { editorKind, textIsBold } from './kinds/index'
import { applyDefaultMarks, BOLD_MARKS } from './richText'
import { chords } from './shortcuts'
import { newBlock } from './store'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

// Полноценное модальное окно выбора типа блока — открывается кнопкой «+». Слева —
// типы по группам (Вопросы / Лэйаут), справа — описание активного типа и пример
// его вида (реальный блок, как в форме), сверху — поиск по названию.
export function BlockTypeDialog({
  open,
  onOpenChange,
  onPick,
  design,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (item: MenuItem) => void
  // Оформление формы — чтобы пример был в её шрифте, цветах и скруглении. Пропом, а не
  // из стора: окно рисуется порталом, и тело тестируется без провайдера стора.
  design?: FormDesign
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-4xl gap-0 overflow-hidden p-0 sm:max-w-4xl"
        // Как у SlashMenu: фокус после вставки ставит движок (handlePickInsertType →
        // engine.focusBlock), возврат фокуса Radix'ом на кнопку «+» глушим.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Добавить блок</DialogTitle>
        <DialogDescription className="sr-only">Выберите тип блока формы.</DialogDescription>
        {/* Тело — отдельный компонент внутри Content: Radix размонтирует его при
            закрытии, поэтому поиск/выбор сбрасываются к дефолту сами, без эффектов. */}
        <DialogBody onPick={onPick} design={design} />
      </DialogContent>
    </Dialog>
  )
}

// Тонкая полоса прокрутки: 6px жёлоба вместо штатных 10 и бегунок тоном подписи на
// трети силы — штатный `bg-border` на белом почти не виден. Задано селектором потомка
// ТЕМ ЖЕ data-slot, что у вендора: полоса рисуется внутри ScrollArea, класс ей снаружи
// не передать.
const THIN_SCROLL =
  '[&_[data-slot=scroll-area-scrollbar]]:w-1.5 [&_[data-slot=scroll-area-thumb]]:bg-muted-foreground/30'

// Рост строки поиска и глифа — зеркало классов CommandDialog (components/ui/command.tsx),
// в котором живёт поиск форм сайдбара: окно «+» собрано на голом Command, и сами они
// сюда не доезжают.
const SEARCH_LOOK =
  '**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12'

export function DialogBody({
  onPick,
  design,
}: {
  onPick: (item: MenuItem) => void
  design?: FormDesign
}) {
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string>(MENU_ITEMS[0]!.key)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? MENU_ITEMS.filter((b) => b.label.toLowerCase().includes(q)) : MENU_ITEMS
  }, [query])

  // Показываемый пункт: активный, если он в отфильтрованном списке, иначе первый
  // видимый. Производное значение — без синхронизации через эффект (setState в
  // эффекте под запретом линта).
  const shown = filtered.some((b) => b.key === activeKey) ? activeKey : filtered[0]?.key
  const activeMeta = MENU_ITEMS.find((b) => b.key === shown)
  // Мемо по пункту: newBlock выдаёт свежие id, и без него пример ремаунтился бы на
  // каждый набранный в поиске символ.
  const sample = useMemo(
    () => (activeMeta && !NO_SAMPLE.has(activeMeta.type) ? sampleBlocks(activeMeta) : null),
    [activeMeta],
  )
  const sampleMeta = sample ? groupMeta(sample).get(SAMPLE_GROUP) : undefined

  return (
    // Список — вендоренный Command: стрелки из поля поиска двигают выделенный пункт,
    // фокус остаётся в поле (клавиатуру cmdk слушает на корне, куда событие всплывает).
    //  • фильтр наш (shouldFilter={false}) — подстрока названия, как и до Command;
    //  • наведение выделение НЕ двигает (disablePointerSelection): превью справа
    //    сменялось бы по пути курсора к кнопке «Добавить», и вставлялся бы не тот тип;
    //  • клик выбирает пункт для превью, двойной клик и Enter — вставляют. Enter гасится
    //    в поле (preventDefault): иначе cmdk дёрнул бы onSelect пункта, а тот лишь выбирает.
    <Command
      shouldFilter={false}
      disablePointerSelection
      value={shown ?? ''}
      onValueChange={setActiveKey}
      className={cn('rounded-none bg-transparent', SEARCH_LOOK)}
      // Имя поля поиска: cmdk вешает на своё поле aria-labelledby на скрытый label
      // корня, и aria-label самого поля он перебивает.
      label="Поиск по названию"
    >
      {/* Шапка — только поиск, во всю ширину и с линией снизу, как окно поиска форм в
          сайдбаре (FormSearch). Крестика нет: окно закрывают Escape и клик мимо. */}
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        onKeyDown={(e) => {
          if (!chords.enter(e)) return
          e.preventDefault()
          if (activeMeta) onPick(activeMeta)
        }}
        placeholder="Поиск по названию…"
      />

      <div className="flex h-[34rem]">
        {/* Левая часть: типы по группам, без подложки, от правой отделена линией.
            Прокрутка — вендоренный ScrollArea с тонкой полосой, а не
            системная: у той своя ширина и цвет в каждом браузере. Своей прокрутки у
            CommandList нет — стрелки cmdk доводят пункт до вида через scrollIntoView,
            и он находит ближайший прокручиваемый предок, то есть viewport. */}
        <ScrollArea className={cn('w-64 shrink-0', THIN_SCROLL)}>
        <CommandList className="max-h-none overflow-visible p-2">
          {BLOCK_GROUP_ORDER.map((g) => {
            const items = filtered.filter((b) => b.group === g)
            if (items.length === 0) return null
            return (
              // Группа с заголовком — не оформление: тот же тип поля намеренно стоит в
              // двух группах, и имя группы — часть смысла пункта. cmdk отдаёт его
              // скринридеру через role="group" + aria-labelledby на заголовок.
              <CommandGroup key={g} heading={BLOCK_GROUP_LABELS[g]} className="p-0">
                {items.map((b) => (
                  <CommandItem
                    key={b.key}
                    value={b.key}
                    onSelect={() => setActiveKey(b.key)}
                    onDoubleClick={() => onPick(b)}
                  >
                    <span className="text-muted-foreground">{b.icon}</span>
                    {b.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )
          })}
          {filtered.length === 0 && (
            <p className="px-2 py-4 text-sm text-muted-foreground">Ничего не найдено</p>
          )}
        </CommandList>
        </ScrollArea>

        <Separator orientation="vertical" />

        {/* Правая часть: описание с кнопкой «Добавить» сверху, под линией — пример.
            Прокручивается только пример: кнопка всегда на виду. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {activeMeta && (
            <>
              <div className="p-4">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{activeMeta.icon}</span>
                  <h3 className="min-w-0 flex-1 text-base font-semibold">{activeMeta.label}</h3>
                  {/* Размер — как у «Опубликовать» в шапке редактора (size="sm"). */}
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onPick(activeMeta)}
                    className="shrink-0"
                  >
                    Добавить <ArrowRight />
                  </Button>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{activeMeta.description}</p>
              </div>

              {sample && (
                <>
                  <Separator />

                  <ScrollArea className={cn('min-h-0 flex-1', THIN_SCROLL)}>
                    <div className="p-4">
                      <div className="mb-2 text-xs text-muted-foreground">Пример</div>
                      {/* Обёртки — те же, что у превью (PreviewPane): контейнер темы с
                          оформлением формы красит холст, заглушка записи рисует календарь,
                          класс группы даёт ритм подписи и поля. Шрифт и выравнивание
                          формы надевает .rf-page, которого здесь нет, — поэтому вручную. */}
                      <SlotStubProvider value={SlotStub}>
                        <div
                          className={`rf-theme ${designClasses(design)}`}
                          style={{
                            ...designToVars(design),
                            fontFamily: 'var(--rf-font-family)',
                            textAlign: 'var(--rf-align)' as React.CSSProperties['textAlign'],
                          }}
                        >
                          <div className={groupClass(sample)}>
                            {sample.map((block) => (
                              <BlockField
                                key={block.id}
                                block={block}
                                captionText={sampleMeta?.caption}
                              />
                            ))}
                          </div>
                        </div>
                      </SlotStubProvider>
                    </div>
                  </ScrollArea>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Command>
  )
}

const SAMPLE_GROUP = 'sample'

// Блоки, которых респондент не видит: примера у них нет, только описание (решение
// владельца 2026-09-15). Страница «Спасибо» — вариант разрыва и попадает сюда же.
const NO_SAMPLE: ReadonlySet<BlockType> = new Set<BlockType>(['page_break', 'logic'])

// sampleBlocks — то, что приедет на полотно по выбору пункта, в виде респондента.
// Форма набора зеркалит вставку (SlashEditor.handlePickInsertType): «Вопросы» —
// подпись + поле (addQuestionAfter); «Отдельные поля» — голое поле, а тип из
// requiresCaption получает подпись (addFieldAfter); «Лэйаут» — один блок с пресетом
// варианта. Блоки собирает newBlock стора, так что дефолты типа те же, что у вставки.
// Отступления от вставки: содержимое (текст подписи и абзаца, два варианта у списков —
// пустой список ничего не показывает) и снятая обязательность (решения владельца
// 2026-09-15).
function sampleBlocks(item: MenuItem): Block[] {
  const make = (type: BlockType, preset?: Partial<Block>): Block => ({
    ...newBlock(type, preset),
    groupId: SAMPLE_GROUP,
    text: sampleText(type),
    // Звёздочку обязательности пример не показывает (решение владельца 2026-09-15). Флаг
    // снимается у блока, а не у подписи: согласие рисует звёздочку само, по required.
    required: false,
  })
  const field = make(item.type, item.preset)
  if (isChoiceType(item.type)) {
    field.settings = {
      ...field.settings,
      options: [
        { id: 's1', label: 'Вариант 1' },
        { id: 's2', label: 'Вариант 2' },
      ],
    }
  }
  const titled =
    item.group === 'question' || (item.group === 'field' && requiresCaption(item.type))
  return titled ? [make('title'), field] : [field]
}

function sampleText(type: BlockType): Block['text'] {
  const text = carriesText(type)
    ? type === 'text'
      ? 'Пример пояснительного текста для респондента.'
      : type.startsWith('heading')
        ? editorKind(type).label
        : type === 'consent'
          ? 'Соглашаюсь с условиями'
          : 'Ваш вопрос'
    : ''
  // Жирность заголовков и подписей живёт в ТЕКСТЕ (марка `b`), поэтому образец обязан
  // её нести: без марки картинка обещала бы обычный вес, а вставленный блок оказался
  // бы жирным — то есть образец врал бы ровно про то, ради чего его и смотрят.
  return applyDefaultMarks(textFromString(text), textIsBold(type) ? BOLD_MARKS : [])
}
