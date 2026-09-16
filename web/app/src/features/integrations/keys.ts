// Фабрика query-ключей интеграций: строковые литералы ключей в компонентах
// запрещены (web/CLAUDE.md). Ключ вложен по formId — привязка одной формы
// инвалидируется, не трогая соседние.
//
// Ключи списков лежат ПОД ключом формы, и это не только про инвалидацию: оверлей
// отличает «грузится список внутри окна» от «перезапрашивается состояние формы»
// ровно по длине ключа (useIsFetching в GoogleSheetsOverlay). Заводишь новый
// список — клади его сюда же, глубже form(), и индикатор подхватит его сам.
export const integrationKeys = {
  all: () => ['integrations'] as const,
  form: (formId: string) => ['integrations', formId] as const,
  // Списки живут у АККАУНТА (ручки адресуются им), но ключ всё равно вложен по
  // ФОРМЕ: от этого зависит индикатор загрузки оверлея, и разносить их значило бы
  // чинить его вторым механизмом. Плата — список таблиц одного аккаунта едет
  // заново при открытии окна на другой форме; staleTime гасит это в пределах
  // сессии, а поход к провайдеру всё равно устаревает.
  spreadsheets: (formId: string, accountId: string) =>
    ['integrations', formId, 'spreadsheets', accountId] as const,
  sheets: (formId: string, accountId: string, spreadsheetId: string) =>
    ['integrations', formId, 'sheets', accountId, spreadsheetId] as const,
  // Счётчики аккаунта Яндекса (фаза 29). Под form() по той же причине, что
  // таблицы: индикатор занятости окна считает ключи глубже ключа формы.
  metrikaCounters: (formId: string, accountId: string) =>
    ['integrations', formId, 'metrika-counters', accountId] as const,
  // Журнал доставок одной связки. Тоже под form(): любая мутация экрана
  // инвалидирует ключ формы, и лента переспрашивается вместе с состоянием —
  // повтор доставки виден в ней сам, без второй инвалидации.
  deliveries: (formId: string, connectionId: string) =>
    ['integrations', formId, 'deliveries', connectionId] as const,
  // Журнал ВЕБХУКА. Отдельный ключ, а не общий с лентой связки: id у них из
  // разных таблиц, и совпадение было бы случайностью, на которую нельзя
  // полагаться.
  webhookDeliveries: (formId: string, webhookId: string) =>
    ['integrations', formId, 'webhook-deliveries', webhookId] as const,
}
