import { type Row } from '@fields/groups'
import { groupSpace, type SpaceStep } from '@fields/space'
import { type Block } from '@entities/formSchema'

// Ступени воздуха перед вопросом на ПОЛОТНЕ — зеркало классов .rf-space-* из fields.css.
// Кому какая ступень положена, решает общий groupSpace (@fields/space); здесь только то,
// чем ступень становится у полотна и КТО из его боксов её носит.
//
// Готовыми строками, а не сборкой из числа: произвольные значения Tailwind статичны,
// класс, собранный из переменной, в CSS не попадёт вовсе — правило исчезнет молча.
const SPACE_MT: Record<SpaceStep, string> = {
  base: 'mt-[calc(0.75rem*var(--rf-density))]',
  // Ступень вопроса — через токен, а не числом: её правит автор (--rf-space-q,
  // design.controls.marginBottom). Класс при этом остаётся статической строкой —
  // собранный из переменной, он в CSS не попал бы вовсе (см. выше).
  q: 'mt-[calc(var(--rf-space-q)*var(--rf-density))]',
  h1: 'mt-[calc(2.5rem*var(--rf-density))]',
  h2: 'mt-[calc(2rem*var(--rf-density))]',
  h3: 'mt-[calc(1.5rem*var(--rf-density))]',
  pb: 'mt-[calc(3rem*var(--rf-density))]',
}

// Единственный отступ СНИЗУ на всём полотне — у разрыва страницы (решение владельца
// 2026-08-22): он разделитель, а не начало куска, и воздух ему нужен с обеих сторон,
// по 48px. Ровно СВОЙ, а не отобранный у соседа: ряд под разрывом свой верхний интервал
// сохраняет и ДОБАВЛЯЕТ его сверху — под разрывом воздуха получается больше, чем над,
// и это осознанно.
const PAGE_BREAK_MB = 'mb-[calc(3rem*var(--rf-density))]'

export const spaceMt = (step: SpaceStep): string => SPACE_MT[step]

// МИНА: у полотна и у превью интервал носят РАЗНЫЕ боксы, хотя выглядеть обязаны
// одинаково. Полноширинный вопрос у превью и рендерера — сам себе прямой ребёнок
// .rf-form (обёртки ряда у одиночки нет вовсе), и ступень достаётся его .rf-group.
// Полотно ряд рисует ВСЕГДА, даже об одном вопросе (он якорь зон жеста), и вопрос
// внутри такого ряда — головной в своей колонке, то есть своего mt не ставит: иначе
// интервал был бы двойным. Значит ступень полноширинного ряда обязана лежать на РЯДУ.
//
// У секции из нескольких колонок ступени нет: там интервал принадлежит ряду как целому
// (12px, .rf-row у превью), а стопку внутри колонки разводят сами вопросы — это и есть
// правило `.rf-cell > *:not(:first-child)` в fields.css.
export function rowSpace(row: Row<{ blocks: Block[] }>): SpaceStep {
  const only = row.length === 1 ? row[0]?.[0] : undefined
  return only ? groupSpace(only.blocks) : 'base'
}

// Отступ ПОД рядом — пусто у всех, кроме разрыва страницы (см. PAGE_BREAK_MB). Отдельной
// функцией, а не полем ступени: «снизу» на полотне ровно один случай, и делать его общим
// механизмом значило бы объявить второй способ задавать интервал.
export function rowSpaceBelow(row: Row<{ blocks: Block[] }>): string {
  const only = row.length === 1 ? row[0]?.[0] : undefined
  const single = only?.blocks.length === 1 ? only.blocks[0]! : undefined
  return single?.type === 'page_break' ? PAGE_BREAK_MB : ''
}
