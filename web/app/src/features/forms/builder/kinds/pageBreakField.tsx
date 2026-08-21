import { useEffect, useRef, useState } from 'react'

import { MAX_PAGE_NAME_LEN, type Block } from '@entities/formSchema'
import { pageName, pageNumbers, thankYouIssue, thankYouOpener } from '@fields/groups'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'

import { useBuilderStore } from '../storeContext'

// Вид разрыва страницы на полотне (фаза 19). Респондент его не видит никогда — он видит
// ПОСЛЕДСТВИЕ: форма разбита на шаги. Поэтому вид живёт здесь, в редакторе, а не в общих
// @fields: в рендерер он не едет и бюджета не занимает.
//
// Отдельным файлом, как DateControl и ImageField: файл типа обязан экспортировать только
// описание типа, иначе fast refresh перестаёт работать на всём модуле.
//
// Номер страницы считается ТЕМ ЖЕ разбиением, что режет форму респонденту (pageNumbers
// поверх splitPages), а не собственным счётом разрывов: собственный счёт разошёлся бы с
// показом на первом же инертном разрыве, и автор увидел бы на полотне страницу, которой у
// респондента нет. Инертный разрыв (два подряд, разрыв в конце, разрыв до всего
// содержимого) остаётся видимым и подписывается без номера — он законное состояние
// черновика, за которым автор ещё допишет блоки.
//
// ДВА КОНТРОЛА РАЗДЕЛИТЕЛЯ, и оба стоят ВСЕГДА, а не появляются по наведению (TD-22:
// контрол, занимающий место в потоке и рождающийся на hover, схлопывается на mousedown, и
// клик уходит мимо цели):
//
//   • тумблер «Страница „Спасибо"» — на КАЖДОМ разрыве и включается всегда (решение
//     владельца 2026-08-21). Показывает ФЛАГ документа, а не производную «действует»:
//     иначе клик по нему на незавершённой форме выглядел бы как поломка — тумблер щёлкнул
//     и сам вернулся. Почему флаг не сработал, говорит строка рядом (thankYouIssue);
//   • подпись — КНОПКА: клик открывает маленький попап с именем страницы. Не инпут по
//     месту (он завёл бы объектной остановке вторую поверхность ввода со своим
//     клавиатурным потоком) и не раздел общего попапа настроек (решение владельца).
//
// Клавиши строки ни один из них не крадёт: ObjectStop перехватывает их только когда фокус
// на самой остановке, а не во внутреннем контроле.
export function PageBreakField({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const opens = useBuilderStore((s) => pageNumbers(s.blocks).get(block.id))
  const active = useBuilderStore((s) => thankYouOpener(s.blocks)?.id === block.id)
  const issue = useBuilderStore((s) => thankYouIssue(s.blocks, block.id))

  const flagged = block.settings?.thankYou === true
  // Тумблер пишет флаг, а не состояние страницы: действует он или нет, решает раскладчик
  // (thankYouOpener). Снятие стирает ключ, а не пишет false, — канон пустых значений не
  // хранит, и лишний ключ означал бы третье состояние там, где их два.
  const setThankYou = (on: boolean) =>
    updateBlock(block.id, {
      settings: { ...block.settings, thankYou: on ? true : undefined },
    })

  return (
    <div className="flex items-center gap-3 py-1 select-none">
      <div className="flex shrink-0 items-center gap-2">
        <Switch id={`thankyou-${block.id}`} checked={flagged} onCheckedChange={setThankYou} />
        <Label htmlFor={`thankyou-${block.id}`} className="cursor-pointer text-xs font-normal">
          Страница «Спасибо»
        </Label>
        {flagged && issue !== null && (
          <span className="text-muted-foreground/60 text-xs">— {ISSUE_TEXT[issue]}</span>
        )}
      </div>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <PageNameButton block={block} opens={opens} active={active} />
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}

// Почему флаг не сработал — словами автора, а не кодом причины.
const ISSUE_TEXT: Record<'empty' | 'not-last' | 'question', string> = {
  empty: 'ниже пока нет блоков',
  'not-last': 'ниже есть ещё страница',
  question: 'на странице есть вопрос',
}

// Подпись-кнопка и попап имени. Имя КОММИТИТСЯ КНОПКОЙ «Применить» (и Enter), а не на
// каждый символ: правка ведётся в локальном черновике, поэтому один заход в попап даёт
// один шаг отмены и один PATCH автосейва. У имени вопроса решено иначе (пишется сразу) —
// там инпут стоит в общем попапе настроек и живёт, пока попап открыт; здесь попап
// одноцелевой, и «Применить» в нём — единственное действие.
function PageNameButton({
  block,
  opens,
  active,
}: {
  block: Block
  opens: number | undefined
  active: boolean
}) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const name = block.settings?.pageName ?? ''
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Фокус в поле — КАДРОМ ПОЗЖЕ открытия, а не атрибутом autoFocus. Полотно держит свой
  // контракт фокуса и после перерисовки строки возвращает каретку на её остановку: с
  // autoFocus поле получало фокус и тут же теряло его обратно кнопке-подписи (видно со
  // второго открытия попапа, когда строка уже перерисовывалась).
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  const apply = () => {
    updateBlock(block.id, { settings: { ...block.settings, pageName: draft } })
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      // Черновик берётся из документа на КАЖДОМ открытии: пока попап был закрыт, имя могло
      // измениться отменой (Mod+Z) или соседней сессией автосейва.
      onOpenChange={(next) => {
        if (next) setDraft(name)
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Название страницы"
          className={`shrink-0 rounded-sm px-1.5 py-0.5 text-xs hover:bg-accent ${
            opens === undefined ? 'text-muted-foreground/60' : 'text-muted-foreground'
          }`}
        >
          {caption(block, opens, active)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="flex w-72 gap-2 p-2">
        <Input
          ref={inputRef}
          className="h-8 text-sm"
          value={draft}
          // Подсказка — то, как страница называется БЕЗ своего имени: автор видит дефолт,
          // не открывая справку, и пустое поле остаётся законным состоянием.
          placeholder={opens === undefined ? 'Страницы за разрывом нет' : pageName(null, opens)}
          // Схема отвергает документ длиннее лимита, и без потолка здесь автосейв ловил бы
          // 422 на 101-м символе — то же правило, что у имени вопроса.
          maxLength={MAX_PAGE_NAME_LEN}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            // Enter не должен доехать до полотна: там он вставляет блок ниже.
            e.preventDefault()
            e.stopPropagation()
            apply()
          }}
        />
        <Button size="sm" className="h-8" onClick={apply}>
          Применить
        </Button>
      </PopoverContent>
    </Popover>
  )
}

// Подпись разделителя. Имя автора и номер стоят ВМЕСТЕ («Контакты #2»): имя говорит, что
// за страница, номер — какая она идёт по счёту, и без номера автор длинной формы теряет
// место. Безымянная страница зовётся номером («Страница 2») — второй раз печатать слово
// «страница» перед решёткой незачем.
//
// У ДЕЙСТВУЮЩЕЙ страницы «Спасибо» номера НЕТ: респондент видит её не шагом, а экраном
// после отправки, и «#3» на ней означало бы шаг, которого в форме нет.
//
// Инертный разрыв (за ним пока ничего) зовётся «Новой страницей» — так же, как пункт
// меню, которым автор его только что вставил: слова «разрыв» он в интерфейсе не видел.
function caption(block: Block, opens: number | undefined, active: boolean): string {
  const own = block.settings?.pageName?.trim()
  if (active) return own || 'Спасибо'
  if (opens === undefined) return own || 'Новая страница'
  return own ? `${own} #${opens}` : pageName(null, opens)
}
