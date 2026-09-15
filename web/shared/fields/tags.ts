// Цвет плашки тега — по позиции варианта в списке блока. Один на все поверхности: у
// респондента (kinds/multiSelect.tsx) и на полотне редактора (BlockRow) плашка одного и
// того же варианта обязана быть одного цвета. Классы rf-tag--c0…c7 — в fields.css.
export const TAG_COLORS = 8

export const tagClass = (index: number): string => `rf-tag rf-tag--c${index % TAG_COLORS}`
