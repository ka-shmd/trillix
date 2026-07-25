import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { FocusEvent } from 'react'
import type { ShortcutContext } from './shortcuts'

// activeRow — где сейчас каретка на полотне, в терминах карты шорткатов (§7 спеки
// реворка). Отвечает на один вопрос: какой контекст показывать в подсказках.
//
// Почему это отдельная штука, а не фокус-движок: движок (focusEngine.ts) умеет СТАВИТЬ
// фокус и о том, где он сейчас, намеренно не знает — он императивный и живёт вне
// рендера. Подсказкам нужно обратное: реактивное «строка X активна», от которого
// перерисовывается UI. Смешивать это в движок значит заставить его дёргать ре-рендер
// на каждое перемещение каретки.
//
// Строка сообщает о себе сама (useRowFocus на своей фокусируемой поверхности) —
// поверхностей у строки несколько (textarea подписи, инпут варианта, инпут
// плейсхолдера, объектная остановка), и только сама поверхность знает свой контекст.

// Название формы и пустое полотно — не блоки, id у них нет. Сентинелы дают им ту же
// адресацию, что и строкам: подсказки различают «активна строка X» и «активен заголовок».
export const TITLE_ROW = '@title'
export const CANVAS_ROW = '@canvas'

export interface ActiveRow {
  // id блока либо сентинел TITLE_ROW/CANVAS_ROW.
  id: string
  ctx: ShortcutContext
  // Есть ли в группе строки отвечаемый блок — от этого зависит, работает ли Mod+Enter
  // (см. shortcutsFor). Осмыслен только у ctx='text'.
  hasAnswer: boolean
}

interface ActiveRowApi {
  activate(row: ActiveRow): void
  // deactivate снимает активность, только если активна ЭТА строка: focusout старой
  // строки приходит перед focusin новой, и безусловное снятие затирало бы уже
  // выставленную новую (а при уходе фокуса из полотна — гасило подсказки, как надо).
  deactivate(id: string): void
}

const ActiveRowValueContext = createContext<ActiveRow | null>(null)
// API отдельным контекстом: он стабилен, поэтому строки-репортёры не перерисовываются
// от смены активной строки. Перерисовываются только читатели значения (чипы,
// шпаргалка) — их ровно столько, сколько нужно.
const ActiveRowApiContext = createContext<ActiveRowApi | null>(null)

export const ActiveRowValueProvider = ActiveRowValueContext.Provider
export const ActiveRowApiProvider = ActiveRowApiContext.Provider

// useActiveRowState — состояние для провайдеров (зовёт полотно). Возвращает значение
// и стабильный API.
export function useActiveRowState(): { active: ActiveRow | null; api: ActiveRowApi } {
  const [active, setActive] = useState<ActiveRow | null>(null)
  const api = useMemo<ActiveRowApi>(
    () => ({
      activate: (row) =>
        setActive((cur) =>
          cur && cur.id === row.id && cur.ctx === row.ctx && cur.hasAnswer === row.hasAnswer
            ? cur // бэйл на ту же строку: лишний setState = лишний ре-рендер подсказок
            : row,
        ),
      deactivate: (id) => setActive((cur) => (cur && cur.id === id ? null : cur)),
    }),
    [],
  )
  return { active, api }
}

// useActiveRow — какая строка активна (null — фокус вне полотна). Для чипов и шпаргалки.
export function useActiveRow(): ActiveRow | null {
  return useContext(ActiveRowValueContext)
}

function useActiveRowApi(): ActiveRowApi | null {
  return useContext(ActiveRowApiContext)
}

// useRowFocus — обработчики фокуса для поверхности строки: спред на textarea/input/
// объектную остановку. Строка объявляет свой контекст один раз, дальше подсказки
// берут его отсюда.
//
// Провайдера может не быть (строки рендерятся и в тестах контракта фокуса без обвязки
// полотна) — тогда хук возвращает пустые обработчики и ничего не ломает.
export function useRowFocus(
  id: string,
  ctx: ShortcutContext,
  hasAnswer = false,
): { onFocus: () => void; onBlur: (e: FocusEvent<Element>) => void } {
  const api = useActiveRowApi()
  // Снятие при размонтировании: у удалённой строки focusout не приходит, и подсказки
  // остались бы висеть от несуществующего блока. id держим в ref (правка ref во время
  // рендера запрещена линтом — синхронизируем эффектом, как в focusEngine).
  const idRef = useRef(id)
  useEffect(() => {
    idRef.current = id
  })
  useEffect(() => () => api?.deactivate(idRef.current), [api])
  return useMemo(
    () => ({
      onFocus: () => api?.activate({ id, ctx, hasAnswer }),
      onBlur: (e: FocusEvent<Element>) => {
        // Переход МЕЖДУ поверхностями одной строки (вариант → соседний вариант) —
        // не уход с неё. Без этой проверки focusout гасит активность, а следующий
        // focusin зажигает её заново: два рендера подряд, и чипы моргают на каждой
        // стрелке по списку вариантов. Свою строку узнаём по data-block-id корня
        // (BlockRow); у сентинелов заголовка/пустого полотна его нет — они гасятся
        // как обычно.
        const to = e.relatedTarget as HTMLElement | null
        if (to?.closest('[data-block-id]')?.getAttribute('data-block-id') === id) return
        api?.deactivate(id)
      },
    }),
    [api, id, ctx, hasAnswer],
  )
}
