// СВОЙ CSS АВТОРА (фаза 22, слайс 7) — то, что уезжает в <style> формы, и правило,
// которое идёт СЛЕДОМ за ним.
//
// Живёт в @fields, а не в рендерере: потребителей двое — рендерер и превью билдера,
// и вывод у них обязан быть один. Превью показывает CSS автора с тех пор, как
// переехало в свой документ (PreviewFrame, TD-60): в общем документе с кабинетом
// <style> автора покрасил бы сам кабинет. Полотно редактора правил автора не
// получает и не получит — там поверх тех же rf-* лежит Tailwind-слой перетаскивания,
// и правило автора ломало бы сам инструмент.
//
// Почему это безопасно, считает не наш код, а CSP (спека §10.1): `script-src 'self'`
// не даёт исполнить JS из CSS, `img-src 'self' data: blob:` — утечь данными через
// url(), `style-src 'self' 'unsafe-inline'` — подтянуть чужой файл через @import.
// Сама строка вставляется React'ом ТЕКСТОВЫМ узлом (инвариант 4), а `</` отвергнут
// валидатором — выйти из <style> в разметку нечем.

// CONSENT_GUARD — правило-сторож, которое печатается ПОСЛЕ авторского CSS.
//
// Что оно защищает и от чего. Спрятанная кнопка отправки или форма, накрытая
// `position: fixed`, — самострел автора на своей форме. Спрятанное СОГЛАСИЕ под кнопкой
// отправки (design/privacy-consent.md) — другое дело: форма собирает персональные
// данные без видимой галочки и документов, и это юридический риск площадки, через
// которую они собираются.
//
// ЧЕСТНО ПРО ГРАНИЦУ: это не стена, а порог. Правила снимают четыре самых дешёвых
// способа спрятать текст (`display: none`, `visibility`, `opacity`, нулевой кегль);
// автор, который целенаправленно уводит согласие за экран `position: absolute; left:
// -9999px` или красит в цвет фона, обойдёт его — и разбором CSS в Go это не чинится
// (свой парсер — не та цена и не та зависимость, ADR §10). Риск принят явно и
// смягчается тремя мерами разом: верхний тариф, потолок объёма и этот порог.
//
// `!important` обязателен: без него правило проигрывает любому авторскому с равной
// специфичностью просто потому, что тот может стоять в более специфичном селекторе.
// Автор с `!important` и более длинным селектором победит и так — см. выше про порог.
//
// Строки текста (`.rf-consent` — фраза и политика) возвращаются к умолчанию браузера,
// контейнеры — к СВОЕМУ значению display: `revert` превратил бы flex-коробку в блок,
// и у любой формы со своим CSS галочка съехала бы с фразы.
// ⚠ Значения display и кегль .rf-consent зеркалят .rf-consent, .rf-consent-box,
// .rf-consent-check и .rf-mark в fields.css — правятся вместе.
export const CONSENT_GUARD =
  `.rf-consent{display:revert !important;visibility:visible !important;opacity:1 !important;font-size:calc(var(--rf-font-size) * var(--rf-ratio-small)) !important}` +
  `.rf-consent-box{display:flex !important;visibility:visible !important;opacity:1 !important}` +
  `.rf-consent-check{display:inline-flex !important;visibility:visible !important;opacity:1 !important}` +
  `.rf-consent-check .rf-mark{display:inline-block !important;visibility:visible !important;opacity:1 !important}`

// customStyleSheet — итоговое содержимое <style> формы: CSS автора, следом сторож.
// Пусто, если автор ничего не писал: печатать пустой <style> с одним сторожем незачем
// — прятать в этом случае нечем.
export function customStyleSheet(css: string | undefined): string {
  const trimmed = css?.trim()
  if (!trimmed) return ''
  return `${trimmed}\n${CONSENT_GUARD}`
}
