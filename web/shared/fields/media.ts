// Публичный URL картинки блока из её ключа в бакете. Относительный `/media/<key>`
// раздаётся same-origin (в проде — Caddy, в dev — vite-proxy; deploy/Caddyfile,
// docs/design/s3-media.md §8), поэтому одинаков для кабинета и рендерера и
// покрывается CSP `img-src 'self'`. Ключ — S3-безопасный (workspaceID/<sha256>.ext),
// дополнительного кодирования не требует.
export function mediaSrc(imageKey: string): string {
  return `/media/${imageKey}`
}
