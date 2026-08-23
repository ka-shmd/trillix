// Фабрика query-ключей интеграций: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md). Ключ вложен по formId — привязка одной формы
// инвалидируется, не трогая соседние.
export const integrationKeys = {
  all: () => ['integrations'] as const,
  form: (formId: string) => ['integrations', formId] as const,
}
