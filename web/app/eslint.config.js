import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  // routeTree.gen.ts — сгенерированный роутером файл, не форматируем и не линтуем.
  { ignores: ['dist', 'src/routeTree.gen.ts'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Инвариант 4 (CLAUDE.md): пользовательский контент рендерится как текст.
      // Через no-restricted-syntax, а не react/no-danger: eslint-plugin-react не
      // установлен, а список зависимостей заморожен — селектор дешевле пакета.
      // Репозиторный дубль этой проверки (включая web/shared, который eslint
      // отсюда не видит) — в scripts/check-docs.sh.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            'Инвариант 4: dangerouslySetInnerHTML запрещён во всём репозитории. Рендери как текст.',
        },
        {
          selector: 'AssignmentExpression > MemberExpression[property.name=/^(inner|outer)HTML$/]',
          message: 'Инвариант 4: присваивание innerHTML/outerHTML запрещено. Рендери как текст.',
        },
      ],
    },
  },
  // Файловые маршруты TanStack Router обязаны экспортировать `Route` рядом с
  // компонентом — это не ошибка fast-refresh, а требование роутера.
  {
    files: ['src/routes/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  // Вендоренный код shadcn/ui (src/components/ui, хуки, lib/utils) — не наш стиль,
  // копируется из реестра как есть. Гасим правила, которые он штатно нарушает
  // (fast-refresh, чистота рендера в примитивах), чтобы не патчить чужой генератор.
  {
    files: ['src/components/ui/**/*.{ts,tsx}', 'src/hooks/**/*.{ts,tsx}', 'src/lib/utils.ts'],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  // eslint-config-prettier — последним: гасит правила форматирования, ими занимается prettier.
  prettier,
)
