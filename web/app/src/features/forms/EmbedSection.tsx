import { Link } from '@tanstack/react-router'

import { type FormDetail } from '../../entities/form'
import { MODE_HINTS, MODE_TITLES, type EmbedMode } from './embedSnippet'
import { Section } from '../../shared/page/Section'

// Блок «Встроить на сайт» на «Поделиться» — ТОЛЬКО три кнопки выбора вида. Настройки,
// код и предпросмотр живут на своём экране (/forms/{slug}/embed): вставку настраивают
// целиком и глядя на результат, а «Поделиться» — страница про ссылку.
const MODES: EmbedMode[] = ['block', 'widget', 'page']

// Виды вставки — плитки, а не строки списка: это три РАЗНЫХ варианта, между которыми
// выбирают. Разделяет их подложка, а не рамка (docs/DESIGN-SYSTEM.md, «плоскость
// вместо рамки»); наведение её усиливает — плитка кликабельна целиком.
export function EmbedSection({ form }: { form: FormDetail }) {
  return (
    <Section title="Встроить на сайт" description="Выберите способ встроить форму на свой сайт.">
      <ul className="grid gap-4 sm:grid-cols-3">
        {MODES.map((mode) => (
          <li key={mode}>
            <Link
              to="/forms/$slug/embed"
              params={{ slug: form.slug }}
              search={(prev) => ({ ...prev, mode })}
              className="block h-full rounded-lg bg-muted/60 p-4 transition-colors hover:bg-muted"
            >
              <span className="block text-base font-semibold">{MODE_TITLES[mode]}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{MODE_HINTS[mode]}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  )
}
