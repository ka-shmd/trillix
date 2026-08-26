import { Link } from '@tanstack/react-router'

import { type FormDetail } from '../../entities/form'
import { MODE_HINTS, MODE_TITLES, type EmbedMode } from './embedSnippet'
import { Section } from '../../shared/page/Section'
import { Card } from '@/components/ui/card'

// Блок «Встроить на сайт» на «Поделиться» — ТОЛЬКО три кнопки выбора вида. Настройки,
// код и предпросмотр живут на своём экране (/forms/{slug}/embed): вставку настраивают
// целиком и глядя на результат, а «Поделиться» — страница про ссылку.
const MODES: EmbedMode[] = ['block', 'widget', 'page']

// Виды вставки — плитки с рамкой, а не строки списка: это три РАЗНЫХ варианта, между
// которыми выбирают, и рамка здесь разделяет разнородное (docs/DESIGN-SYSTEM.md).
export function EmbedSection({ form }: { form: FormDetail }) {
  return (
    <Section
      title="Встроить на сайт"
      description="Форма встанет прямо на вашу страницу, ответы придут сюда же. Выберите вид — дальше можно будет настроить его и посмотреть на результат."
    >
      <ul className="grid gap-4 sm:grid-cols-3">
        {MODES.map((mode) => (
          <li key={mode}>
            <Card className="h-full p-0 transition-colors hover:bg-muted/50">
              <Link
                to="/forms/$slug/embed"
                params={{ slug: form.slug }}
                search={(prev) => ({ ...prev, mode })}
                className="block h-full p-4"
              >
                <span className="block text-base font-semibold">{MODE_TITLES[mode]}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{MODE_HINTS[mode]}</span>
              </Link>
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  )
}
