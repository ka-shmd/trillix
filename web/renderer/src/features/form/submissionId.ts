// UUIDv7 генерируется на клиенте один раз на попытку отправки: ретраи после сбоя
// сети шлют тот же id, и сервер (ON CONFLICT DO NOTHING) не создаёт дубля —
// идемпотентность (DEV-PLAN фаза 5, шаг 4). Своя реализация ~15 строк: зависимость
// uuid в рендерер тянуть нельзя (бюджет бандла, web/CLAUDE.md).
//
// Формат RFC 9562 v7: 48 бит миллисекунд Unix + версия/вариант + случайные биты.
export function uuidv7(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  const ts = Date.now()
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff
  bytes[5] = ts & 0xff
  bytes[6] = (bytes[6]! & 0x0f) | 0x70 // версия 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // вариант RFC 4122

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
