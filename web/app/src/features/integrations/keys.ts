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
  spreadsheets: (formId: string) => ['integrations', formId, 'spreadsheets'] as const,
  sheets: (formId: string, spreadsheetId: string) =>
    ['integrations', formId, 'sheets', spreadsheetId] as const,
}
