import { Link } from '@tanstack/react-router'

import { type FormDetail } from '../../entities/form'
import { MODE_HINTS, MODE_TITLES, type EmbedMode } from './embedSnippet'

// Блок «Встроить на сайт» на «Поделиться» — ТОЛЬКО три кнопки выбора вида. Настройки,
// код и предпросмотр живут на своём экране (/forms/{slug}/embed): вставку настраивают
// целиком и глядя на результат, а «Поделиться» — страница про ссылку.
const MODES: EmbedMode[] = ['block', 'widget', 'page']

export function EmbedSection({ form }: { form: FormDetail }) {
  return (
    <div className="mt-8 rounded-lg border p-5">
      <h2 className="text-base font-medium">Встроить на сайт</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Форма встанет прямо на вашу страницу, ответы придут сюда же. Выберите вид — дальше можно
        будет настроить его и посмотреть на результат.
      </p>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {MODES.map((mode) => (
          <Link
            key={mode}
            to="/forms/$slug/embed"
            params={{ slug: form.slug }}
            search={(prev) => ({ ...prev, mode })}
            className="rounded-md border p-3 text-left hover:bg-muted/50"
          >
            <span className="block text-sm font-medium">{MODE_TITLES[mode]}</span>
            <span className="mt-1 block text-xs text-muted-foreground">{MODE_HINTS[mode]}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
