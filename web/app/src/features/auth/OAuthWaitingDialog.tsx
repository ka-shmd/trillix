import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { providerTitle } from '../../entities/identity'

// Ожидание похода к провайдеру, начатого из отдельного окна. Занимает экран
// целиком и непрозрачной подложкой убирает форму входа: пока идёт вход в
// соседнем окне, тыкать в поля и кнопки под ним нечего — они относятся к
// другому способу входа и половина из них уведёт вкладку со страницы, оставив
// окно сиротой.
//
// Именно Dialog, а не свой слой с fixed inset-0: Radix уводит фон из
// табуляции и из чтения скринридером. Слой, который только закрашивает, до
// формы внизу пускает клавиатуру.
export function OAuthWaitingDialog({
  provider,
  onCancel,
}: {
  provider: string
  onCancel: () => void
}) {
  return (
    // Escape и клик мимо карточки означают то же, что «Отменить»: другого
    // способа выйти из ожидания у человека нет, и запирать его здесь нельзя.
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-background"
        className="border-none shadow-none sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Ждём подтверждения в окне провайдера {providerTitle(provider)}</DialogTitle>
          <DialogDescription>
            Подтвердите вход в открывшемся окне — оно закроется само. Эту вкладку не закрывайте:
            продолжение будет здесь.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Отменить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
