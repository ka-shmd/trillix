import { type AnimateLayoutChanges } from '@dnd-kit/sortable'

// После дропа dnd-kit «доигрывает» layout-анимацию перетащенного элемента от его
// СТАРОЙ layout-позиции (useDerivedTransform меряет rect до перестановки): элемент
// отскакивает на прежнее место и заново едет к новому. У строк это маскировалось
// ремаунтом (блок после дропа обычно меняет группу-родителя), у групп артефакт
// был виден всегда. Отключаем на обоих слоях (GroupRow и BlockRow): дроп фиксирует
// элемент сразу там, где его бросили. Остальным элементам дефолт и так ничего не
// анимирует (defaultAnimateLayoutChanges срабатывает только при wasDragging).
export const noLayoutAnimation: AnimateLayoutChanges = () => false
