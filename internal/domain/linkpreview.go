package domain

import "unicode/utf8"

// Карточка ссылки на форму — то, что рисуют мессенджеры, соцсети и поисковики,
// получив адрес /r/{slug}. ЖИВЫЕ ДАННЫЕ (колонка forms.link_preview), а не поле
// схемы, по тому же правилу, что настройки закрытия: схема снапшотится публикацией
// и внутри версии неизменна, а карточка описывает не документ, который увидит
// респондент, а вид самой ссылки — и правка обязана доезжать до мессенджера без
// перепубликации (ARCHITECTURE §3.4, ADR §10).
//
// Все поля необязательны и каждое независимо: пустое значит «взять дефолт»
// (имя сервиса, заголовок формы, общий слоган, брендовая картинка), а не «показать
// пустоту».
// Поэтому карточка, у которой заполнен только заголовок, — законное и частое
// состояние, а не полуфабрикат.

const (
	// MaxLinkPreviewSiteNameLen — og:site_name: имя площадки над заголовком
	// карточки. Тот же класс, что имя вопроса, — короткий ярлык, не текст.
	MaxLinkPreviewSiteNameLen = 100
	// MaxLinkPreviewTitleLen — og:title. Тот же лимит, что у заголовка формы: это
	// его замена, и разные потолки означали бы, что заголовок формы в карточку не
	// помещается целиком.
	MaxLinkPreviewTitleLen = MaxFormTitleLen
	// MaxLinkPreviewDescriptionLen — og:description. Площадки обрезают описание
	// раньше, но потолок здесь про хранение, а не про показ.
	MaxLinkPreviewDescriptionLen = 500
)

// LinkPreview — своя карточка ссылки формы. Хранится в forms.link_preview как
// JSONB; отсутствие всей карточки (NULL в колонке) и карточка из пустых строк —
// одно и то же состояние, и второе в базу не попадает (см. Empty).
type LinkPreview struct {
	// SiteName — og:site_name.
	SiteName string `json:"siteName,omitempty"`
	// Title — og:title и <title> вкладки.
	Title string `json:"title,omitempty"`
	// Description — og:description и <meta name="description">.
	Description string `json:"description,omitempty"`
	// ImageKey — ключ картинки карточки в бакете медиа (og:image). Ключ, а не URL:
	// URL в данных означал бы миграцию при смене провайдера раздачи (ADR §10).
	// Абсолютный адрес собирает публичный слой — краулеры относительный не
	// резолвят.
	ImageKey string `json:"imageKey,omitempty"`
	// IconKey — ключ иконки площадки (<link rel="icon"> страницы формы). Отдельная
	// картинка, а не вырезка из ImageKey: у иконки другой потолок ширины и другой
	// смысл — её показывают в 16–32 px рядом с адресом.
	IconKey string `json:"iconKey,omitempty"`
}

// Empty — карточка ничего не переопределяет. Пустая карточка не хранится: колонке
// достаётся NULL, и у «не настраивали» остаётся ровно одно представление. Иначе
// каждый читатель обязан знать оба.
func (p *LinkPreview) Empty() bool {
	return p == nil || (p.SiteName == "" && p.Title == "" && p.Description == "" &&
		p.ImageKey == "" && p.IconKey == "")
}

// ValidateLinkPreview — серверная проверка карточки (инвариант 3, независимо от
// фронта). Чистая функция без HTTP/SQL; нарушение → ErrValidation (→ 422).
//
// Ключи картинок проверяются только на длину — как imageKey блока и обложки:
// существование объекта в бакете схема не гарантирует и гарантировать не может
// (картинку можно удалить из хранилища мимо формы), а битый ключ даёт отсутствующую
// картинку в карточке, а не сломанную страницу.
func ValidateLinkPreview(p *LinkPreview) error {
	if p == nil {
		return nil
	}
	for _, f := range []struct {
		name string
		v    string
		max  int
	}{
		{"siteName", p.SiteName, MaxLinkPreviewSiteNameLen},
		{"title", p.Title, MaxLinkPreviewTitleLen},
		{"description", p.Description, MaxLinkPreviewDescriptionLen},
		{"imageKey", p.ImageKey, MaxImageKeyLen},
		{"iconKey", p.IconKey, MaxImageKeyLen},
	} {
		if n := utf8.RuneCountInString(f.v); n > f.max {
			return schemaErr("linkPreview: %s длиннее %d символов", f.name, f.max)
		}
	}
	return nil
}
