import { useEffect, useState } from 'react'

import { colsFor } from './slotList'

// Сколько квадратов класть в страницу ленты — меряется по САМОЙ ленте.
//
// ResizeObserver, а не медиазапрос: ширину блоку задаёт автор формы (--rf-column), и
// окно браузера о ней ничего не говорит. Первый вызов приходит сразу на observe —
// отдельного замера при монтировании не нужно.
//
// Ссылка отдаётся функцией, а не объектом-ref: лента появляется не сразу (у пикера —
// после ответа сервера), и эффект обязан дождаться самого элемента, а не первого
// рендера.
export function useCols(): { cols: number; ref: (el: HTMLDivElement | null) => void } {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [cols, setCols] = useState(colsFor(0))
  useEffect(() => {
    // Нет ResizeObserver (тесты в happy-dom, старый браузер) — лента остаётся с полом
    // colsFor, то есть с неделей. Это рабочий вид, а не заглушка.
    if (!box || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setCols(colsFor(box.clientWidth)))
    ro.observe(box)
    return () => ro.disconnect()
  }, [box])
  return { cols, ref: setBox }
}
