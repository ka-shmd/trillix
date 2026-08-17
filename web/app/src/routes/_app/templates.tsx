import { createFileRoute } from '@tanstack/react-router'

import { TemplatesView } from '../../features/forms/templates/TemplatesView'

// Шаблоны форм (/templates): встроенные заготовки, с которых начинают вместо пустого
// полотна. Входов два — пункт сайдбара и ссылка «Использовать шаблон» на пустом
// полотне (SlashEditor, EmptyStarter).
export const Route = createFileRoute('/_app/templates')({
  component: TemplatesView,
})
