import { createContext, useContext, useEffect, useRef } from 'react'
import type { CaretEdge } from './caret'

// Фокус-движок полотна (§2.5 спеки реворка) — ЕДИНЫЙ источник правды о фокусе:
// строки регистрируют свою фокус-цель, а обработчики просят `focusBlock(id, edge)`.
// Стор остаётся чистым документом; его операции возвращают id созданного блока —
// движок их потребляет.

// FocusTarget — то, что строка регистрирует: как поставить на неё фокус. Для
// текстовых строк цель оборачивает их CaretAdapter; объектные остановки (image/
// date/scale) и инпуты полей/вариантов регистрируют свои цели в следующих срезах
// 13.1 (§2.1). Строка без зарегистрированной цели фокус не принимает (focusBlock —
// no-op на ней), что сохраняет сегодняшнее поведение до тех срезов.
export interface FocusTarget {
  // 'defer' — поверхности, которая примет каретку, сейчас нет, но цель её готовит
  // (свёрнутый список вариантов разворачивается, collapsedOptions.ts). Запрос остаётся
  // отложенным и исполнится, когда поверхность зарегистрирует свою цель под тем же id.
  focus(edge: CaretEdge): void | 'defer'
  // standIn — заглушка на месте поверхности (свёрнутая строка): отвечает только на явный
  // focusBlock, страховка ремаунта её не зовёт. Иначе клик по шеврону сворачивал вопрос,
  // а регистрация заглушки под id последнего фокуса при фокусе в body тут же его
  // разворачивала (так бывает после удаления строки из вопроса).
  standIn?: boolean
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
  // Последний поставленный фокус — страховка от ремаунта. focusBlock часто зовут
  // синхронно в обработчике, ДО коммита React; если операция меняет groupId строки,
  // GroupRow перемонтируется целиком, сфокусированный элемент гибнет и фокус падает
  // в body (так пропадала каретка при «/» → вопрос). Новая цель того же id при
  // регистрации возвращает каретку, если фокус к этому моменту потерян.
  let last: { id: string; edge: CaretEdge } | null = null

  const focusLost = () =>
    document.activeElement === null || document.activeElement === document.body

  return {
    register(id, target) {
      targets.set(id, target)
      if (pending && pending.id === id) {
        if (target.focus(pending.edge) !== 'defer') pending = null
      } else if (!target.standIn && last && last.id === id && focusLost()) {
        target.focus(last.edge)
      }
      return () => {
        // Снимаем только СВОЮ регистрацию: при ремаунте строки с тем же id новый
        // target уже мог перезаписать запись — чужую чистить нельзя.
        if (targets.get(id) === target) targets.delete(id)
      }
    },
    focusBlock(id, edge = 'end') {
      last = { id, edge }
      const t = targets.get(id)
      if (!t || t.focus(edge) === 'defer') pending = { id, edge }
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
  focus: (edge: CaretEdge) => void | 'defer',
  enabled = true,
  standIn = false,
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
    return engine.register(id, { focus: (edge) => focusRef.current(edge), standIn })
  }, [engine, id, enabled, standIn])
}
