// Ответ на один блок формы. Текстовые типы и single_choice хранят строку;
// multi_choice — массив id выбранных опций. Общий тип для рендерера (useReducer
// хранит карту blockId → Answer) и контролов полей @fields.
export type Answer = string | string[]

// Переключение варианта в multi_choice: добавить id при выборе, убрать при снятии.
// Чистая функция — покрывается юнит-тестом (тривиальная, но именно она правит
// массив ответа, поэтому вынесена из JSX-контрола).
export function toggleMulti(current: readonly string[], id: string, checked: boolean): string[] {
  return checked ? [...current, id] : current.filter((x) => x !== id)
}
