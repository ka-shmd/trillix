import { z } from 'zod'

// Способ входа через провайдера на экране настроек (фаза 23, слайс E).
// Идентификатора у провайдера здесь нет и быть не должно: человеку он ничего
// не говорит, карточку подписывает адрес.
export const identitySchema = z.object({
  provider: z.string(),
  // Пустая строка — привязка старше миграции 0021: адрес приедет на ближайшем
  // входе через этого провайдера, до тех пор карточка подписана только датой.
  providerEmail: z.string(),
  connectedAt: z.string(),
})

export type Identity = z.infer<typeof identitySchema>

// Человеческое имя провайдера. Неизвестный код показываем как есть: это лучше,
// чем «Неизвестный провайдер» — по крайней мере видно, что подключено.
const providerTitles: Record<string, string> = {
  yandex: 'Яндекс',
  vk: 'VK ID',
}

export function providerTitle(provider: string): string {
  return providerTitles[provider] ?? provider
}
