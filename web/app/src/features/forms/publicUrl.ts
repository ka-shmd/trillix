// Базовый URL публичной части (рендерер). Различие контуров живёт в конфигурации:
// в dev переменной обычно нет → fallback на локальный рендерер; фаза 7 задаёт
// VITE_PUBLIC_BASE_URL на этапе сборки прод-контуров. Единая точка — её используют
// страница «Поделиться» и контрол публикации в шапке редактора.
const PUBLIC_BASE =
  (import.meta.env.VITE_PUBLIC_BASE_URL as string | undefined) ?? 'http://localhost:5174'

// Публичная ссылка на форму по её slug.
export const publicFormUrl = (slug: string): string => `${PUBLIC_BASE}/r/${slug}`

// Хост публичной части — для карточки-превью ссылки (домен, как его показывает
// мессенджер). На неразбираемом URL возвращаем строку как есть.
export function publicFormHost(): string {
  try {
    return new URL(PUBLIC_BASE).host
  } catch {
    return PUBLIC_BASE
  }
}
