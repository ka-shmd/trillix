import { DESIGN_THEMES } from '@entities/formSchema'

import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

import { currentTheme, withTheme } from './designTheme'
import { useBuilderStore } from './storeContext'

// ПАНЕЛЬ «ОФОРМЛЕНИЕ» — ВЫЕЗЖАЮЩАЯ ШТОРКА (фаза 22, слайс 3; вид согласован с
// владельцем 2026-08-09 по образцу Tally).
//
// Шторка, а не отдельный режим вместо полотна, по одной причине, и она же главная:
// автор смотрит НЕ на панель, а на форму за ней. Тема меняется у него на глазах —
// полотно остаётся на месте, перерисовывается и остаётся редактируемым. Панель,
// закрывающая полотно, показывала бы результат только после выхода из неё, то есть
// превращала бы подбор темы в угадывание.
//
// Отсюда два отступления от вендоренного Sheet:
//   • modal={false} — фокус не запирается, полотно кликабельно;
//   • showOverlay={false} — затемнение убивает ровно тот смысл, ради которого
//     шторка и выбрана (добавка к компоненту, см. sheet.tsx).
//
// СОХРАНЕНИЕ — АВТОСЕЙВОМ, в отличие от «Настроек формы» с их кнопкой. Разница не в
// непоследовательности: настройки это поля ввода, где человек ждёт «применить», а
// тема — один жест выбора с немедленным результатом. Кнопка «Сохранить» под
// дропдауном означала бы, что выбранная тема ещё не выбрана.
export function DesignDrawer({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const design = useBuilderStore((s) => s.design)
  const setDesign = useBuilderStore((s) => s.setDesign)

  // Обе тонкости выбора («светлая = отсутствие ключа», «пустой остаток = undefined»)
  // живут в designTheme.ts отдельным модулем — ровно чтобы их можно было проверить
  // тестом: Radix Select в happy-dom не открывается вовсе (STATUS.md), и через
  // разметку эта логика непокрываема.
  const theme = currentTheme(design)

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        showOverlay={false}
        // Шторка не должна забирать фокус с полотна при открытии: автор пришёл
        // смотреть на форму, а не печатать в панели.
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Клик по полотну — обычный клик по полотну, а не «закрыть панель»: иначе
        // любая правка формы при открытой шторке захлопывала бы её.
        onInteractOutside={(e) => e.preventDefault()}
        className="w-80 sm:max-w-80"
        aria-label="Оформление формы"
      >
        <SheetHeader>
          <SheetTitle>Оформление</SheetTitle>
          <SheetDescription>Как форма выглядит у респондента.</SheetDescription>
        </SheetHeader>

        <div className="grid gap-2 px-4">
          <Label htmlFor="design-theme">Тема</Label>
          <Select
            value={theme}
            onValueChange={(next) => setDesign(withTheme(design, next as 'light' | 'dark'))}
          >
            <SelectTrigger id="design-theme" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DESIGN_THEMES.map((value) => (
                <SelectItem key={value} value={value}>
                  {THEME_TITLES[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// Подписи — здесь, а не в @entities: список значений это контракт (его сверяет
// паритет-тест с Go), а перевод на человеческий — дело интерфейса.
const THEME_TITLES: Record<(typeof DESIGN_THEMES)[number], string> = {
  light: 'Светлая',
  dark: 'Тёмная',
}
