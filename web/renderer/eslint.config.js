import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // react-refresh здесь больше нет: рендерер работает на preact/compat, а
      // @vitejs/plugin-react (и его fast refresh) убран — правило о границах
      // HMR стерегло бы несуществующий механизм. Правила хуков остаются: они
      // про сам React-API, который в исходниках никуда не делся.
      // Инвариант 4 (CLAUDE.md): пользовательский контент рендерится как текст.
      // Здесь он особенно горяч — это публичная страница чужой формы.
      // Через no-restricted-syntax, а не react/no-danger: eslint-plugin-react не
      // установлен, список зависимостей заморожен. Репозиторный дубль (включая
      // web/shared, который eslint отсюда не видит) — в scripts/check-docs.sh.
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
  // eslint-config-prettier — последним: гасит правила форматирования, ими занимается prettier.
  prettier,
)
