import { createPortal } from 'react-dom'

import { useAppChromeSlots } from '../appChrome'
import { PageContainer, type PageWidth } from './PageContainer'

// Подвал страницы — полоса, приклеенная к нижнему краю окна, под ОДНО действие
// страницы целиком: «Сохранить» на настройках формы. Пара верхнему бару: там путь
// и вход в другие экраны, здесь — итог работы на этом.
//
// Подвал один на приложение и живёт в оболочке (`routes/_app.tsx`), а страница
// отправляет в него содержимое порталом — тем же приёмом, что крошки и действия
// бара (shared/appChrome.ts). Полоса без содержимого скрыта (`empty:hidden` на
// узле оболочки): на экранах без подвала лишней линии у нижнего края нет.
//
// СОДЕРЖИМОЕ СТОИТ В КОЛОНКЕ СВОЕЙ СТРАНИЦЫ, а полоса идёт во всю ширину: кнопка
// обязана оказаться под правым краем той колонки, из которой она сохраняет, —
// иначе полоса читается как чужой элемент, случайно оказавшийся внизу. Ширину
// поэтому передаёт страница, ту же, что у её `PageContainer`.
export function PageFooter({
  width = 'default',
  children,
}: {
  width?: PageWidth
  children: React.ReactNode
}) {
  const { footer } = useAppChromeSlots()
  if (!footer) return null

  // Поля колонки страницы (32px сверху, 32 снизу) полосе не подходят: у неё своя
  // высота, заданная кнопкой и воздухом вокруг неё.
  return createPortal(
    <PageContainer width={width} className="py-3">
      {children}
    </PageContainer>,
    footer,
  )
}
