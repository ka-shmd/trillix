import { type Control, textValue } from './contract'

// Запись на время. На этой поверхности контрол ПОКАЗЫВАЕТ выбранное время и не
// выбирает его: живой пикер (список дат и времён) уезжает в рендерер отдельным
// ленивым чанком со своим бюджетом — ADR §10, слайс E фазы 27.
//
// Поверхностей у контрола три, и все три ему по силам:
//   • редактор и превью — расписание сюда не приезжает вовсе, стоит приглашение;
//   • печатный лист — в значении лежит время, записанное сервером, его и печатаем.
//
// ⚠ У ЗНАЧЕНИЯ ДВА ФОРМАТА (internal/domain/answers.go, validateSlotAnswer): id
// брони — то, что шлёт браузер респондента, и время RFC3339 — то, что пишет сервер.
// Показывать здесь можно только второе; id брони человеку не значит ничего, поэтому
// неразобранное значение показывается приглашением, а не сырой строкой.
export const slotControl: Control = (p) => {
  const at = parseTime(textValue(p.value))
  return (
    <div className="rf-slot" aria-label={p.label} aria-invalid={p.invalid || undefined}>
      {at ? (
        <span className="rf-slot-value">{at}</span>
      ) : (
        <span className="rf-slot-empty">Выбор времени записи</span>
      )}
    </div>
  )
}

// parseTime — время записи человеческим видом. Пояс — тот, в котором открыта
// страница: печатный лист получает пояс расписания данными и подставляет его сам
// (слайс I), а до тех пор виден пояс читателя.
function parseTime(raw: string): string | null {
  if (raw === '') return null
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}
