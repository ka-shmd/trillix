// Лимиты контракта — те же числа, что в Go (internal/domain/schema.go). Длины строк
// на фронте считаются в UTF-16 code units (JS), в Go — в рунах; для ASCII-id и
// обычного текста расхождение несущественно, а серверная проверка в любом случае
// финальна.
//
// Почему отдельный файл, а не «каждый лимит в файле своего типа» (фаза 16, спека
// §3.6): лимиты читает И схема настроек (settings.ts), И файлы типов, а те импортируют
// contract.ts, который импортирует settings.ts. Лимит в файле типа замкнул бы этот
// путь в цикл. Поэтому лимиты — ЛИСТ дерева импортов: сам не импортирует ничего.
//
// Все они реэкспортируются из formSchema.ts — точка входа контракта для приложений не
// менялась и не должна меняться.

export const MAX_BLOCKS = 200
export const MAX_OPTIONS = 100
// Суммарная длина текста блока по всем спанам (title/label/heading/text/consent).
// Зеркалит MaxTextLen. Число то же, что было у строки в v2: текст не стал длиннее от
// того, что его покрасили.
export const MAX_TEXT_LEN = 2000
// Число спанов в тексте одного блока. Зеркалит MaxSpans. Второй лимит обязателен: без
// него MAX_TEXT_LEN перестал быть лимитом документа в тот момент, когда строка стала
// массивом (2000 кусков по одному символу прошли бы проверку длины).
export const MAX_SPANS = 200
// Длина заголовка ФОРМЫ (блок form_title), в рунах. Не MAX_TEXT_LEN: заголовок уезжает
// зеркалом в forms.title, оттуда — в <title>, og:title и в потолок поискового запроса,
// поэтому у него свой, более тесный лимит. Зеркалит MaxFormTitleLen.
export const MAX_FORM_TITLE_LEN = 200
// Длина ИМЕНИ вопроса (фаза 16): строки, которой вопрос называется в данных —
// заголовок колонки CSV, подпись шага воронки, ключ сводки. Не MAX_TEXT_LEN: это
// короткий идентификатор для аналитики, а не текст вопроса. Зеркалит
// MaxQuestionNameLen.
export const MAX_QUESTION_NAME_LEN = 100
export const MAX_OPTION_LABEL_LEN = 500
export const MAX_ID_LEN = 64
export const MAX_SUBMIT_LABEL_LEN = 100
export const MAX_PLACEHOLDER_LEN = 200
// Ключ объекта картинки в бакете (uuid/<sha256>.ext ~ 105 симв.).
export const MAX_IMAGE_KEY_LEN = 200
// Экран «после отправки»: текст благодарности владельца и ссылка перехода.
export const MAX_THANK_YOU_TEXT_LEN = 2000
export const MAX_REDIRECT_URL_LEN = 2000
// Границы диапазона шкалы. Верх — 10: шкала это ряд кнопок, а не поле ввода, и на
// телефоне больше десяти в строку не помещается (нужно число — есть тип number).
// Низ — 0: NPS считается от нуля. Диапазон новой шкалы — 1–5.
export const SCALE_LOWER_BOUND = 0
export const SCALE_UPPER_BOUND = 10
export const DEFAULT_SCALE_MIN = 1
export const DEFAULT_SCALE_MAX = 5
