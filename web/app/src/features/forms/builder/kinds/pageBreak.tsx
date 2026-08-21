import { SeparatorHorizontal } from 'lucide-react'

import { type EditorKind } from './contract'
import { PageBreakField } from './pageBreakField'

// Разрыв страницы (фаза 19) — граница между страницами формы: всё, что ниже него,
// респондент увидит следующим шагом. Страница сущностью схемы не является, её выводит
// splitPages (@fields/groups), как groupId выводит regroup.
//
// Объектная остановка, как картинка и дата: своего текста у разрыва нет, править внутри
// строки нечего — каретка встаёт на строку саму, кольцом.
export const pageBreak: EditorKind = {
  // Только «Лэйаут»: ответа не собирает, бандлом с подписью не вставляется.
  menu: { question: false, field: false, layout: true },
  label: 'Разрыв страницы',
  description: 'Граница страниц: всё, что ниже, респондент увидит следующим шагом.',
  icon: <SeparatorHorizontal className="size-4" />,
  // Раздела в общем попапе настроек у типа НЕТ: имя страницы правится своим маленьким
  // попапом, который открывает КЛИК ПО ПОДПИСИ разделителя (решение владельца 2026-08-21,
  // образец — Tally). Второе место для того же значения означало бы две правды об одном.
  row: { surface: 'object', lineH: 'h-6', Control: PageBreakField, hint: 'object' },
}
