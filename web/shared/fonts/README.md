# Шрифты формы

Самохост, и только он: прод-CSP отдаёт `font-src 'self' data:`, а подключённый с
чужого CDN шрифт — это запрос браузера **респондента** на посторонний сервер, то есть
передача его IP третьему лицу на публичной странице сбора персональных данных.

| Файл | Семейство | Лицензия | Источник |
|---|---|---|---|
| `inter-cyrillic.woff2`, `inter-latin.woff2` | Inter | SIL OFL 1.1 — [`OFL-inter.txt`](OFL-inter.txt) | Google Fonts, `css2?family=Inter:wght@400..800` |
| `golos-cyrillic.woff2`, `golos-latin.woff2` | Golos Text | SIL OFL 1.1 — [`OFL-golos-text.txt`](OFL-golos-text.txt) | Google Fonts, `css2?family=Golos+Text:wght@400..800` |
| `manrope-cyrillic.woff2`, `manrope-latin.woff2` | Manrope | SIL OFL 1.1 — [`OFL-manrope.txt`](OFL-manrope.txt) | Google Fonts, `css2?family=Manrope:wght@400..800` |
| `onest-cyrillic.woff2`, `onest-latin.woff2` | Onest | SIL OFL 1.1 — [`OFL-onest.txt`](OFL-onest.txt) | Google Fonts, `css2?family=Onest:wght@400..800` |
| `montserrat-cyrillic.woff2`, `montserrat-latin.woff2` | Montserrat | SIL OFL 1.1 — [`OFL-montserrat.txt`](OFL-montserrat.txt) | Google Fonts, `css2?family=Montserrat:wght@400..800` |
| `lora-cyrillic.woff2`, `lora-latin.woff2` | Lora (антиква, веса 400–700) | SIL OFL 1.1 — [`OFL-lora.txt`](OFL-lora.txt) | Google Fonts, `css2?family=Lora:wght@400..700` |

**Lora — единственная засечная и единственная с усечённым диапазоном весов:** выше 700
семейство не нарисовано, и заявленные полотном 800 браузер зажимает к 700 (вариативному
шрифту синтетический жир не делают). Заголовок формы на Lora поэтому чуть легче, чем на
остальных, — это цена антиквы в списке, а не дефект подключения. Хвост стека у неё тоже
свой (`Georgia, 'Times New Roman', serif`): системный гротеск в хвосте означал бы, что
секунду до загрузки файла форма выглядит другой формой.

**Текст лицензии лежит рядом с файлами, а не только назван в таблице.** OFL требует,
чтобы лицензия сопровождала распространяемое Font Software, а мы именно распространяем:
woff2 уезжают браузеру каждого респондента со своего origin. Файлы взяты дословно из
`google/fonts` (`ofl/inter/OFL.txt`, `ofl/golostext/OFL.txt`) — тело у них общее,
различаются строкой копирайта, поэтому и хранятся по одному на семейство.

Файлы **вариативные** (один на всё семейство, веса 100–900 либо 400–900): полотно
использует пять весов, и статикой это было бы десять файлов вместо двух.
Подмножества кириллицы и латиницы раздельные — браузер скачивает только то, что
встретилось в тексте.

Подключение — `@font-face` в [`../fields/fields.css`](../fields/fields.css)
**относительным** путём: так файлы обрабатывает сборщик каждого приложения и
раздаёт со своего origin. Класть их в `public/` нельзя — копию пришлось бы держать
в обоих приложениях (кабинет и рендерер это разные origin со своим `font-src 'self'`).

Суммарный вес сторожит `npm run check:bundle` в рендерере — отдельным порогом от
бюджета JS: шрифт не в бандле, но респондент его качает.

**Дефолтное семейство — Inter** (`DesignFontDefault` в `internal/domain/design_vars.go`,
`--rf-font-family` в `:root` `fields.css`, `DESIGN_FONT_DEFAULT` в `formSchema.ts`): форма,
у которой автор шрифт не выбирал, набрана им и preload'ит его файлы. Меняешь дефолт —
меняй все три места; расхождение Go и CSS краснеет паритет-тестом, третье место — панель.

**Добавляя семейство:** файл сюда, **текст лицензии отдельным файлом рядом**, строка
в таблицу выше (лицензия обязательна, кириллица во всех весах обязательна), два
`@font-face` в `fields.css`, значение в
`DESIGN_FONTS` (`web/shared/entities/formSchema.ts`) и в `designFonts`
(`internal/domain/design.go`) — состав сверяется паритет-тестом, — стек в
`FONT_STACK`/`designFontStack` обоих зеркал и подпись в панели оформления.
