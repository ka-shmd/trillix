import { Link } from '@tanstack/react-router'

import { type FormDetail } from '../../entities/form'
import { MODE_TITLES, type EmbedMode } from './embedSnippet'
import { EmbedModeArt } from './EmbedModeArt'
import { Section } from '../../shared/page/Section'

// Блок «Встроить на сайт» на «Поделиться» — ТОЛЬКО три кнопки выбора вида. Настройки,
// код и предпросмотр живут на своём экране (/forms/{slug}/embed): вставку настраивают
// целиком и глядя на результат, а «Поделиться» — страница про ссылку.
const MODES: EmbedMode[] = ['block', 'widget', 'page']

// Виды вставки — три миниатюры с подписью: разница между ними пространственная (где
// на чужой странице окажется форма), и картинка объясняет её быстрее строки текста.
// Поэтому пояснений под подписями больше нет — их работу делает сама миниатюра.
// Полный текст остался там, где картинки нет: в выпадающем списке на экране вставки.
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
              className="group block rounded-lg"
            >
              {/* Подложка только на миниатюре: подпись стоит под ней, как у картинки,
                  и заливка под текстом превратила бы пару в одну плитку. */}
              <EmbedModeArt
                mode={mode}
                className="w-full rounded-lg transition-opacity group-hover:opacity-80"
              />
              <span className="mt-3 block text-center text-base font-semibold">
                {MODE_TITLES[mode]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  )
}
