import { type BlockType } from '@entities/formSchema'
import { BLOCK_TYPES } from './blockTypes'
import { typeIcons } from './blockTypeIcons'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Полноценное модальное окно выбора типа блока — открывается кнопкой «+» (в строке
// и внизу полотна). В отличие от slash-меню («/» → поповер), это диалог с сеткой
// типов. Выбор создаёт блок нужного типа и закрывает окно.
export function BlockTypeDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (type: BlockType) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Добавить блок</DialogTitle>
          <DialogDescription>Выберите тип блока формы.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {BLOCK_TYPES.map((t) => (
            <button
              key={t.type}
              type="button"
              onClick={() => onPick(t.type)}
              className="flex items-center gap-2.5 rounded-lg border p-3 text-left text-sm font-medium transition-colors hover:border-primary/40 hover:bg-accent hover:text-accent-foreground"
            >
              <span className="text-muted-foreground">{typeIcons[t.type]}</span>
              {t.label}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
