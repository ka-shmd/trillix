// Фабрика query-ключей forms: строковые литералы ключей в компонентах запрещены
// (web/CLAUDE.md), только отсюда.
export const formKeys = {
  all: () => ['forms'] as const,
  // list() — префикс всех списков: им инвалидируют разом любые поиск/сортировку
  // (мутация меняет выдачу при любых параметрах).
  list: () => ['forms', 'list'] as const,
  // listWith() — конкретный список: свой кэш на каждую пару (поиск, сортировка),
  // иначе смена сортировки показала бы чужие страницы из кэша прежней.
  listWith: (params: { q: string; sort: string }) => ['forms', 'list', params] as const,
  // detail ключуется slug'ом формы (идентификатор URL кабинета), не UUID:
  // роут даёт slug, мутации патчат кэш по возвращённому form.slug.
  detail: (slug: string) => ['forms', 'detail', slug] as const,
  // detailAll() — префикс всех деталей: нужен там, где на руках только UUID формы,
  // а её slug ещё неизвестен (оптимистичный патч rename — см. queries.ts).
  detailAll: () => ['forms', 'detail'] as const,
}
