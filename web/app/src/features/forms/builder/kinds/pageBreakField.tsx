// Вид разрыва страницы на полотне (фаза 19). Респондент его не видит никогда — он видит
// ПОСЛЕДСТВИЕ: форма разбита на шаги. Поэтому вид живёт здесь, в редакторе, а не в общих
// @fields: в рендерер он не едет и бюджета не занимает.
//
// Отдельным файлом, как DateControl и ImageField: файл типа обязан экспортировать только
// описание типа, иначе fast refresh перестаёт работать на всём модуле.
export function PageBreakField() {
  return (
    <div className="flex select-none items-center gap-3 py-1">
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span className="text-xs uppercase tracking-wide text-muted-foreground">Разрыв страницы</span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  )
}
