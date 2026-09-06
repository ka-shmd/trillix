import { type EditorKind } from './contract'
import { SlotControl } from './slotControl'
import { SlotSettings } from './slotSettings'

export const slot: EditorKind = {
  // Разделы те же, что у любого отвечаемого типа: их состав — инвариант реестра, и
  // держит его registry.test.ts.
  menu: { question: true, field: true, layout: false },
  label: 'Запись на время',
  description: 'Респондент выбирает свободное время из вашего расписания.',
  // Объектная остановка: своего текста у поля нет, править внутри строки нечего —
  // каретка встаёт на саму плашку, как у даты и файла.
  // lineH — высота кластера значков строки, а не контрола: он ровняется по ПЕРВОЙ
  // строке, а первая строка здесь — подпись месяца над лентой, как у файла и картинки.
  row: { surface: 'object', Control: SlotControl, hint: 'object', lineH: 'h-6' },
  // Расписание правится в попапе, а не на полотне: у респондента этого выбора нет —
  // он видит только его последствие, свободное время.
  Settings: SlotSettings,
}
