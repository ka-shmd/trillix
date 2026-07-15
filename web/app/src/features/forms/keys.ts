// Фабрика query-ключей forms: строковые литералы ключей в компонентах запрещены
// (web/CLAUDE.md), только отсюда.
export const formKeys = {
  all: () => ['forms'] as const,
  list: () => ['forms', 'list'] as const,
  // detail ключуется slug'ом формы (идентификатор URL кабинета), не UUID:
  // роут даёт slug, мутации патчат кэш по возвращённому form.slug.
  detail: (slug: string) => ['forms', 'detail', slug] as const,
}
