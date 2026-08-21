import { type Block, MAX_PAGE_NAME_LEN } from '@entities/formSchema'
import { lastPageOpener, pageNumbers, thankYouBlocked, thankYouOpener } from '@fields/groups'

import { Label } from '@/components/ui/label'
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
// РАЗДЕЛИТЕЛЬ НЕСЁТ ДВА КОНТРОЛА (2026-08-21) — имя страницы и тумблер «Спасибо». Оба
// стоят ВСЕГДА, а не появляются по наведению: контрол, занимающий место в потоке и
// рождающийся на hover, схлопывается на mousedown, и клик уходит мимо цели (TD-22).
// Клавиши строки они не крадут — ObjectStop перехватывает их только когда фокус на самой
// остановке, а не во внутреннем контроле.
export function PageBreakField({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const opens = useBuilderStore((s) => pageNumbers(s.blocks).get(block.id))
  // Тумблер осмыслен ровно на одном разрыве — том, что открывает последнюю страницу:
  // экран после отправки не может стоять посреди формы. Автор дописал страницу ниже —
  // тумблер уехал на её разрыв, а флаг на этом стал инертным (и погас сам).
  const isLast = useBuilderStore((s) => lastPageOpener(s.blocks)?.id === block.id)
  const active = useBuilderStore((s) => thankYouOpener(s.blocks)?.id === block.id)
  // Считается всегда, а не только у последнего разрыва: селектор, закрывающийся над
  // значением другого селектора, читает его прошлый рендер — а разница между «страница
  // последняя» и «на ней вопрос» тут ровно одна строка JSX ниже.
  const blocked = useBuilderStore((s) => thankYouBlocked(s.blocks))

  const name = block.settings?.pageName ?? ''
  // Подсказка инпута = то, как страница называется БЕЗ своего имени. Так автор видит
  // дефолт, не открывая справку, и пустое поле остаётся законным состоянием.
  const fallback = active
    ? 'Спасибо'
    : opens === undefined
      ? 'Разрыв страницы'
      : `Страница ${opens}`

  const setName = (value: string) =>
    updateBlock(block.id, { settings: { ...block.settings, pageName: value } })
  // Тумблер пишет флаг, а не состояние страницы: действует он или нет, решает раскладчик
  // (thankYouOpener). Снятие стирает ключ, а не пишет false, — канон пустых значений не
  // хранит, и лишний ключ в документе означал бы третье состояние там, где их два.
  const setThankYou = (on: boolean) =>
    updateBlock(block.id, {
      settings: { ...block.settings, thankYou: on ? true : undefined },
    })

  return (
    <div className="flex select-none items-center gap-3 py-1">
      {isLast && (
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            id={`thankyou-${block.id}`}
            checked={active}
            // Погашенный и НЕДОСТУПНЫЙ, когда правило нарушено: включать его нечем, пока
            // на странице стоит вопрос, и живой тумблер с молчаливым отказом читался бы
            // как поломка. Причина — строкой рядом.
            disabled={blocked !== null}
            onCheckedChange={setThankYou}
          />
          <Label htmlFor={`thankyou-${block.id}`} className="cursor-pointer text-xs font-normal">
            Страница «Спасибо»
          </Label>
          {blocked === 'question' && (
            <span className="text-xs text-muted-foreground/60">— уберите вопрос со страницы</span>
          )}
        </div>
      )}
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={fallback}
        maxLength={MAX_PAGE_NAME_LEN}
        aria-label="Название страницы"
        // Ширина фиксированная, а не по содержимому: линии по бокам обязаны стоять ровно
        // независимо от длины имени. Регистр — как автор набрал: uppercase остался у
        // подписей полотна, но в поле ввода он превращал бы «Контакты» в «КОНТАКТЫ».
        //
        // Взаимоисключающие рамки разведены по состояниям (web/CLAUDE.md): border-transparent
        // и border-border одинаковой специфичности, и «базовый плюс перебивка» тут не работает.
        className={`w-40 rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-center text-xs outline-none hover:border-border focus:border-ring ${
          opens === undefined ? 'text-muted-foreground/60' : 'text-muted-foreground'
        }`}
      />
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}
