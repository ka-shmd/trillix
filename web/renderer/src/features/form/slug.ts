// slug формы из пути /r/{slug} — роутера в рендерере нет (web/CLAUDE.md), путь
// разбираем сами. Не тот формат (корень, лишние сегменты) → пустая строка →
// экран «форма недоступна» без запроса к API.
export function slugFromPath(pathname: string): string {
  const m = pathname.match(/^\/r\/([^/]+)\/?$/)
  return m ? decodeURIComponent(m[1] ?? '') : ''
}
