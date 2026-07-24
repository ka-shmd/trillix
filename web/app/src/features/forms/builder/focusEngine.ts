import { createContext, useContext, useEffect, useRef } from 'react'
import type { CaretEdge } from './caret'

// Фокус-движок полотна (§2.5 спеки реворка) — ЕДИНЫЙ источник правды о фокусе.
// Прежде фокусом рулил `focusId` в SlashEditor (проп через GroupRow → BlockRow), а
// в сторе параллельно жил мёртвый `selectedId`. Теперь фокус живёт в одном месте:
// строки регистрируют свою фокус-цель, а обработчики просят `focusBlock(id, edge)`.
// Стор остаётся чистым документом; его операции возвращают id созданного блока —
// движок их потребляет.

// FocusTarget — то, что строка регистрирует: как поставить на неё фокус. Для
// текстовых строк цель оборачивает их CaretAdapter; объектные остановки (image/
// date/scale) и инпуты полей/вариантов регистрируют свои цели в следующих срезах
// 13.1 (§2.1). Строка без зарегистрированной цели фокус не принимает (focusBlock —
// no-op на ней), что сохраняет сегодняшнее поведение до тех срезов.
export interface FocusTarget {
  focus(edge: CaretEdge): void
}

export interface FocusEngine {
  // register вызывается строкой на монтировании; возвращает функцию снятия.
  register(id: string, target: FocusTarget): () => void
  // focusBlock ставит фокус на строку блока. Если строка ещё не смонтировалась
  // (только что вставлена стором), запрос запоминается и применяется, как только
  // строка зарегистрирует цель. edge по умолчанию 'end' (каретка в конец, как
  // прежний focusLabelEnd).
  focusBlock(id: string, edge?: CaretEdge): void
}

export function createFocusEngine(): FocusEngine {
  const targets = new Map<string, FocusTarget>()
  // Отложенный запрос: focusBlock звали раньше, чем строка смонтировалась.
  let pending: { id: string; edge: CaretEdge } | null = null

  return {
    register(id, target) {
      targets.set(id, target)
      if (pending && pending.id === id) {
        target.focus(pending.edge)
        pending = null
      }
      return () => {
        // Снимаем только СВОЮ регистрацию: при ремаунте строки с тем же id новый
        // target уже мог перезаписать запись — чужую чистить нельзя.
        if (targets.get(id) === target) targets.delete(id)
      }
    },
    focusBlock(id, edge = 'end') {
      const t = targets.get(id)
      if (t) t.focus(edge)
      else pending = { id, edge }
    },
  }
}

// Один движок на инстанс полотна (SlashEditor держит его в useMemo и раздаёт через
// контекст; строки берут хуком). Не модульный синглтон: билдер может открывать
// разные формы, у каждой — свой стор и свой движок.
const FocusEngineContext = createContext<FocusEngine | null>(null)
export const FocusEngineProvider = FocusEngineContext.Provider

export function useFocusEngine(): FocusEngine {
  const engine = useContext(FocusEngineContext)
  if (!engine) throw new Error('useFocusEngine вызван вне FocusEngineProvider')
  return engine
}

// useRegisterFocusTarget — строка регистрирует свою фокус-цель в движке на всё время
// жизни. `focus` может меняться каждый рендер (замыкает актуальные refs/props) —
// держим его в ref, поэтому регистрация стабильна и не пере-подписывается на каждую
// правку. `enabled=false` — цель не регистрируется (у блока в этом типе нет своей
// поверхности: напр. AnswerField для date рисует превью, а фокус-цель — объектная
// остановка вокруг него).
export function useRegisterFocusTarget(
  id: string,
  focus: (edge: CaretEdge) => void,
  enabled = true,
): void {
  const engine = useFocusEngine()
  // Latest-ref: держим актуальный focus, не пере-подписывая регистрацию на каждый
  // рендер. Начальное значение — из useRef(focus); обновляем в эффекте (правка ref
  // во время рендера запрещена правилом react-hooks/refs).
  const focusRef = useRef(focus)
  useEffect(() => {
    focusRef.current = focus
  })
  useEffect(() => {
    if (!enabled) return
    return engine.register(id, { focus: (edge) => focusRef.current(edge) })
  }, [engine, id, enabled])
}
