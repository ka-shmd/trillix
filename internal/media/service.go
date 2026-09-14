package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/jpeg" // именованный импорт регистрирует JPEG-декодер для image.Decode/DecodeConfig
	"image/png"  // и PNG-декодер
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/image/draw"

	"github.com/ka-shmd/trillix/internal/blob"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/safehttp"
)

const (
	// MaxImageBytes — потолок тела загрузки; handler ставит MaxBytesReader.
	MaxImageBytes = 5 << 20 // 5 МиБ
	// MaxImagePixels — гард площади до полного декода (decompression-bomb).
	MaxImagePixels = 24_000_000 // 24 Мпикс
	// MaxImageWidth — потолок ШИРИНЫ хранимой картинки. Число выведено из вида
	// формы, а не выбрано на глаз: колонка — 700 CSS-px (`.rf-page` в
	// web/shared/fields/fields.css: max-width 860 минус 2×80 паддинга), а
	// `.rf-image` — это max-width:100%/height:auto, то есть отображение
	// ограничивает ТОЛЬКО ширину, высота едет следом. 700×2 = 1400 покрывает
	// экраны с DPR 2; мобильный случай уже: ~350 CSS-px при DPR 3 = 1050.
	// Меняешь ширину колонки — меняй и это.
	//
	// Кап именно по ширине, а не по длинной стороне: у высокого портрета
	// (1200×3000) кап длинной стороны срезал бы ширину до 640 и сделал картинку
	// НЕДОразрешённой для той же колонки — оптимизация во вред.
	MaxImageWidth = 1400
	// MaxCoverWidth — потолок ширины ОБЛОЖКИ. Она тянется во всю ширину окна, а не
	// колонки, поэтому 1400 ей мало: типовой ноутбук — 1440–1680 CSS-px. 2000
	// покрывает его с запасом и даёт DPR 2 на мобильном (390×2 = 780) и DPR 3
	// (1170). Полный ретина-десктоп (2×1440 = 2880) сознательно НЕ даём: обложка
	// декоративна, и полтора лишних мегабайта у респондента дороже её резкости.
	MaxCoverWidth = 2000
	// MaxLogoWidth — потолок ширины ЛОГОТИПА. Он рисуется ~72 CSS-px (`.rf-logo`),
	// то есть сегодня хватило бы 216 (DPR 3). 512 взято с запасом на смену размера
	// и не стоит ничего заметного: плоская графика в этих габаритах — единицы КиБ.
	MaxLogoWidth = 512
	// MaxPreviewWidth — потолок ширины КАРТИНКИ КАРТОЧКИ ССЫЛКИ (og:image).
	// 1200 — не наш вкус, а канон площадок: и Open Graph, и Twitter Card
	// показывают карточку в 1200×630, и всё, что шире, они всё равно ужмут сами,
	// заплатив трафиком респондента. Ретина-запаса здесь не нужно: карточку
	// рисует чужой клиент в своих габаритах, а не наша страница.
	//
	// Кадрирование до 630 по высоте мы НЕ делаем: обрезать чужую картинку вслепую
	// значит отрезать половину того, что автор в неё вложил. Непопадание в
	// пропорцию площадки видно в предпросмотре окна — там та же рамка 1200×630.
	MaxPreviewWidth = 1200
	// MaxIconWidth — потолок ширины ИКОНКИ площадки (favicon карточки и вкладки).
	// Её показывают в 16–32 CSS-px; 256 покрывает любой DPR и заодно тот размер,
	// в котором иконку берут агрегаторы. Меньше логотипа (512) намеренно: это не
	// знак страницы, а значок рядом с адресом.
	MaxIconWidth = 256
	// MaxAvatarSide — потолок ДЛИННОЙ стороны аватара. Аватар рисуется кружком
	// (~40 CSS-px в сайдбаре, 96 в настройках), поэтому 512 покрывает любой DPR
	// с запасом. Потолок здесь на длинной стороне, а не на ширине, как у
	// остальных назначений: кружок обрезает картинку по КОРОТКОЙ стороне
	// (object-cover), и у высокого портрета кап по ширине оставил бы 512×3000 —
	// три мегапикселя ради 512 видимых.
	MaxAvatarSide = 512
	// avatarKeyPrefix — неймспейс аватаров в бакете. Воркспейса у аватара нет
	// (он принадлежит человеку, а не пространству), поэтому вместо его id —
	// собственный префикс.
	avatarKeyPrefix = "avatars"
	// jpegQuality — качество при ре-энкоде JPEG.
	jpegQuality = 85
)

// Purpose — НАЗНАЧЕНИЕ картинки: где она будет показана. Влияет ровно на одно —
// потолок ширины при нормализации. Отдельный параметр, а не догадка по размеру
// входа: обложку от картинки блока по пикселям не отличить, а хранить обложку в
// ширину колонки (или логотип в ширину обложки) одинаково неправильно.
//
// Хранилище от назначения НЕ зависит: ключ по-прежнему контент-адресный, бакет и
// политика те же. Поэтому Purpose не попадает ни в ключ, ни в схему — одна и та же
// картинка, загруженная дважды с разным назначением, даст два объекта, и это
// нормально: у них разное содержимое (разная ширина).
type Purpose string

const (
	PurposeBlock Purpose = "block"
	PurposeCover Purpose = "cover"
	PurposeLogo  Purpose = "logo"
	// PurposePreview и PurposeIcon — картинка и иконка карточки ссылки на форму.
	// Показывает их не наша страница, а мессенджер или соцсеть, поэтому потолки
	// у них взяты из канона площадок, а не из вида формы.
	PurposePreview Purpose = "preview"
	PurposeIcon    Purpose = "icon"
	PurposeAvatar  Purpose = "avatar"
)

// targetWidth — ширина, до которой ужимать картинку этого назначения при
// исходных размерах w×h. Неизвестное назначение сюда не доезжает: его отвергает
// ParsePurpose на границе.
func (p Purpose) targetWidth(w, h int) int {
	switch p {
	case PurposeCover:
		return MaxCoverWidth
	case PurposeLogo:
		return MaxLogoWidth
	case PurposePreview:
		return MaxPreviewWidth
	case PurposeIcon:
		return MaxIconWidth
	case PurposeAvatar:
		if h <= w {
			return MaxAvatarSide
		}
		// Портрет: под потолок уводится высота, ширина едет следом.
		side := int(math.Round(float64(MaxAvatarSide) * float64(w) / float64(h)))
		if side < 1 {
			side = 1
		}
		return side
	default:
		return MaxImageWidth
	}
}

// ParsePurpose разбирает назначение из запроса. Пустое = block: так выглядят
// загрузки картинки блока, которые про параметр не знают. Неизвестное значение —
// ошибка, а не молчаливый откат к block: опечатка в назначении означала бы обложку,
// ужатую до ширины колонки, и заметили бы это глазами через неделю.
//
// PurposeAvatar здесь НЕ разбирается: аватар приезжает своей ручкой
// (POST /api/v1/account/avatar), а не полем формы, и «avatar» в этом параметре
// означало бы картинку блока, ужатую до 512.
func ParsePurpose(s string) (Purpose, error) {
	switch Purpose(s) {
	case "", PurposeBlock:
		return PurposeBlock, nil
	case PurposeCover:
		return PurposeCover, nil
	case PurposeLogo:
		return PurposeLogo, nil
	case PurposePreview:
		return PurposePreview, nil
	case PurposeIcon:
		return PurposeIcon, nil
	default:
		return "", fmt.Errorf("%w: неизвестное назначение картинки %q", domain.ErrValidation, s)
	}
}

// Forms — узкий интерфейс потребителя над forms.Service: авторизует членство и
// резолвит WorkspaceID формы. Get возвращает ErrNotFound для чужой/несуществующей
// формы (приватное не раскрывается).
type Forms interface {
	Get(ctx context.Context, userID, formID uuid.UUID) (forms.Form, error)
}

// blobStore — узкий интерфейс над S3-клиентом. Кладёт объект и — с появлением
// печати ответов (ADR §10) — отдаёт его обратно.
//
// Чтение здесь НЕ отменяет прежнего порядка: респонденту картинки по-прежнему
// раздаёт Caddy прямо из бакета, мимо приложения. Через Go ходит ровно один
// читатель — headless-браузер принтера: у него нет ни нашего домена, ни доверия к
// сертификату prod-local, и путь до картинки у него ровно один — тот же api,
// который отдал ему страницу.
type blobStore interface {
	PutObject(ctx context.Context, bucket, key string, data []byte, contentType string) error
	GetObject(ctx context.Context, bucket, key string) (data []byte, contentType string, err error)
}

// imageFetcher — узкий интерфейс над safehttp.Client: скачать картинку по адресу,
// который дал автор. Защита от SSRF живёт в клиенте (ADR §10), сюда в тестах
// подставляется фейк.
type imageFetcher interface {
	Validate(ctx context.Context, raw string) (*url.URL, error)
	Get(ctx context.Context, rawURL string, limit int64) (safehttp.Response, []byte, error)
}

// Service — приём картинок. Хранилище скрыто за blobPutter, авторизация — за Forms.
type Service struct {
	forms  Forms
	blob   blobStore
	bucket string
	fetch  imageFetcher
}

func NewService(f Forms, b blobStore, bucket string) *Service {
	return &Service{forms: f, blob: b, bucket: bucket}
}

// WithFetcher подключает загрузку картинки по ссылке. Без него UploadFromURL
// отвечает недоступностью (503), а не пустым ключом.
func (s *Service) WithFetcher(f imageFetcher) *Service {
	s.fetch = f
	return s
}

// keyPattern — что вообще может быть ключом картинки: `workspaceID/<sha256>.<ext>`.
// Проверяется на ЧТЕНИИ, потому что ключ там приходит из URL, а не из нашей базы:
// без проверки «..» в пути уводил бы запрос в соседний бакет.
var keyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$`)

// Fetch отдаёт картинку по ключу — байты и их тип. Единственный потребитель —
// печатная страница ответа (см. blobStore): она открыта браузером принтера, для
// которого наш api это весь мир.
//
// Прав не спрашивает, и это не упущение: те же байты по тому же ключу Caddy отдаёт
// любому желающему прямо из бакета — картинки формы публичны по построению.
func (s *Service) Fetch(ctx context.Context, key string) ([]byte, string, error) {
	if !keyPattern.MatchString(key) || strings.Contains(key, "..") {
		return nil, "", domain.ErrNotFound
	}
	data, contentType, err := s.blob.GetObject(ctx, s.bucket, key)
	if err != nil {
		// Пропавший объект — 404, а не 500: ключ приезжает из чужого документа
		// (схема старой версии могла ссылаться на картинку, которую уже унесла
		// чистка сирот), и лист без картинки лучше отказа печатать вовсе.
		if errors.Is(err, blob.ErrNotFound) {
			return nil, "", domain.ErrNotFound
		}
		return nil, "", fmt.Errorf("fetch media %s: %w", key, err)
	}
	return data, contentType, nil
}

// Upload авторизует членство и кладёт картинку формы в бакет, возвращая стабильный
// ключ workspaceID/<sha256>.<ext>. Порядок: сначала проверка доступа (инвариант 1),
// затем обработка байтов.
func (s *Service) Upload(ctx context.Context, userID, formID uuid.UUID, data []byte, purpose Purpose) (string, error) {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return "", err // ErrNotFound для чужой/несуществующей — не раскрываем приватное
	}

	return s.put(ctx, form.WorkspaceID.String(), data, purpose)
}

// UploadFromURL — та же загрузка картинки формы, что Upload, но байты сервер берёт по
// адресу, который дал автор (вкладка «Ссылка» окна обложки). Чужой адрес в схему не
// пишется: CSP страницы формы пускает картинки только со своего origin, а схема
// хранит ключ, а не URL (docs/S3.md), — поэтому картинка ложится в бакет, как файл.
//
// Порядок тот же, что у Upload: сначала право (инвариант 1), потом сеть. Отказ адреса
// или ответа — 422 с человеческой причиной; сам адрес в текст ошибки не попадает —
// в пути ссылки бывают токены.
func (s *Service) UploadFromURL(ctx context.Context, userID, formID uuid.UUID, rawURL string, purpose Purpose) (string, error) {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return "", err
	}
	if s.fetch == nil {
		return "", fmt.Errorf("%w: загрузка по ссылке не настроена", domain.ErrUnavailable)
	}
	// Validate — ради внятного отказа до соединения; защищает соединение само (control).
	if _, err := s.fetch.Validate(ctx, rawURL); err != nil {
		return "", urlImportError(err)
	}
	resp, data, err := s.fetch.Get(ctx, rawURL, MaxImageBytes)
	if err != nil {
		return "", urlImportError(err)
	}
	switch {
	case resp.StatusCode >= 300 && resp.StatusCode < 400:
		// Редирект клиент не выполняет (ADR §10): публичный адрес уводил бы во
		// внутреннюю сеть. Короткие ссылки и «поделиться» у фотостоков — ровно этот случай.
		return "", fmt.Errorf("%w: ссылка перенаправляет на другой адрес — вставьте прямую ссылку на картинку", domain.ErrValidation)
	case resp.StatusCode != http.StatusOK:
		return "", fmt.Errorf("%w: по ссылке нет картинки — сайт ответил кодом %d", domain.ErrValidation, resp.StatusCode)
	}
	return s.put(ctx, form.WorkspaceID.String(), data, purpose)
}

// urlImportError переводит отказ адреса или соединения в человеческую причину (422).
func urlImportError(err error) error {
	var text string
	switch {
	case errors.Is(err, safehttp.ErrBodyTooLarge):
		text = fmt.Sprintf("картинка по ссылке больше %d МБ", MaxImageBytes>>20)
	case errors.Is(err, safehttp.ErrScheme):
		text = "ссылка должна начинаться с https://"
	case errors.Is(err, safehttp.ErrUserInfo):
		text = "уберите логин и пароль из ссылки"
	case errors.Is(err, safehttp.ErrMalformed):
		text = "это не похоже на ссылку — проверьте, что она скопирована целиком"
	case errors.Is(err, safehttp.ErrOwnHost):
		text = "это адрес самого Trillix — загрузите картинку файлом"
	default:
		switch safehttp.Classify(err) {
		case safehttp.FailureForbidden:
			text = "ссылка ведёт во внутреннюю сеть — оттуда картинки не загружаются"
		case safehttp.FailureNotFound:
			text = "сайт с таким адресом не найден — проверьте ссылку"
		case safehttp.FailureTimeout:
			text = fmt.Sprintf("сайт не отдал картинку за %d секунд", int(safehttp.DefaultTimeout/time.Second))
		case safehttp.FailureTLS:
			text = "сертификат сайта не прошёл проверку"
		default:
			text = "не удалось скачать картинку по ссылке"
		}
	}
	return fmt.Errorf("%w: %s", domain.ErrValidation, text)
}

// PutAvatar кладёт аватар и возвращает его ключ avatars/<sha256>.<ext>.
// Авторизации здесь нет, и это не пропуск: аватар принадлежит человеку, а не
// ресурсу, и доказательством права служит сессия — её проверил вызывающий
// (auth, ручка /account/avatar). Ключ в users.avatar_key пишет тоже он: media
// про пользователей не знает и знать не должен.
func (s *Service) PutAvatar(ctx context.Context, data []byte) (string, error) {
	return s.put(ctx, avatarKeyPrefix, data, PurposeAvatar)
}

// put — общая половина обеих загрузок: валидация и нормализация байтов
// (ре-энкод снимает EXIF/GPS), контент-адресный ключ под переданным префиксом,
// запись в бакет. Ключ по содержимому делает PUT идемпотентным (дедуп).
func (s *Service) put(ctx context.Context, prefix string, data []byte, purpose Purpose) (string, error) {
	ext, contentType, canonical, err := decodeReencode(data, purpose)
	if err != nil {
		return "", err
	}

	sum := sha256.Sum256(canonical)
	key := fmt.Sprintf("%s/%s%s", prefix, hex.EncodeToString(sum[:]), ext)

	if err := s.blob.PutObject(ctx, s.bucket, key, canonical, contentType); err != nil {
		return "", fmt.Errorf("put media object: %w", err)
	}
	return key, nil
}

// decodeReencode проверяет, что вход — PNG/JPEG, гардит площадь, уменьшает картинку
// до потолка назначения и пере-кодирует в канонические байты (снимая EXIF/GPS и
// нормализуя). Возвращает расширение, content-type и новые байты. Любая проблема
// входа → ErrValidation (422).
func decodeReencode(data []byte, purpose Purpose) (ext, contentType string, out []byte, err error) {
	// Тип по контенту, не по заголовку/имени файла.
	sniff := detectImageType(data)
	if sniff == "" {
		return "", "", nil, fmt.Errorf("%w: неподдержанный тип файла (только PNG/JPEG)", domain.ErrValidation)
	}

	// Гард площади до полного декода (защита от decompression-bomb).
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", "", nil, fmt.Errorf("%w: не удалось прочитать размеры картинки", domain.ErrValidation)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > MaxImagePixels {
		return "", "", nil, fmt.Errorf("%w: картинка больше %d пикселей", domain.ErrValidation, MaxImagePixels)
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", "", nil, fmt.Errorf("%w: не удалось декодировать картинку", domain.ErrValidation)
	}

	return encodeCanonical(downscale(img, purpose.targetWidth(cfg.Width, cfg.Height)))
}

// downscale уменьшает картинку до maxWidth по ширине, сохраняя пропорции.
// Только уменьшает: то, что уже уже потолка (логотип, узкая высокая полоса),
// возвращается нетронутым — апскейл добавил бы байт, не добавив деталей.
func downscale(img image.Image, maxWidth int) image.Image {
	b := img.Bounds()
	if b.Dx() <= maxWidth {
		return img
	}
	h := int(math.Round(float64(b.Dy()) * float64(maxWidth) / float64(b.Dx())))
	if h < 1 {
		h = 1 // очень широкая полоса: высота не должна схлопнуться в ноль
	}
	dst := image.NewRGBA(image.Rect(0, 0, maxWidth, h))
	// CatmullRom — интерполяция с резкостью, заметно лучше билинейной на
	// сильном уменьшении (фото с телефона ужимается втрое и больше).
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	return dst
}

// encodeCanonical выбирает формат хранения ПО СОДЕРЖИМОМУ, а не по формату входа:
// PNG, присланный поверх фотографии, иначе так и остался бы мегабайтным PNG.
//
//   - есть полупрозрачные пиксели → только PNG (JPEG не умеет альфу);
//   - непрозрачная → кодируем обоими и берём меньший результат. Так фотография
//     уезжает в JPEG, а плоская графика и логотипы остаются в PNG без потерь,
//     и порога, который надо было бы подбирать на глаз, не появляется.
func encodeCanonical(img image.Image) (ext, contentType string, out []byte, err error) {
	// Уровень сжатия — дефолтный. BestCompression пробовался и отвергнут по
	// замеру: на 1400×1050 он даёт байт в байт тот же размер (2707,5 КиБ на фото,
	// 6,7 КиБ на плоской графике), а на графике вдвое медленнее — 27 мс против 13.
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		return "", "", nil, fmt.Errorf("encode png: %w", err)
	}
	if !isOpaque(img) {
		return ".png", "image/png", pngBuf.Bytes(), nil
	}

	var jpegBuf bytes.Buffer
	if err := jpeg.Encode(&jpegBuf, img, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return "", "", nil, fmt.Errorf("encode jpeg: %w", err)
	}
	if pngBuf.Len() <= jpegBuf.Len() {
		return ".png", "image/png", pngBuf.Bytes(), nil
	}
	return ".jpg", "image/jpeg", jpegBuf.Bytes(), nil
}

// isOpaque сообщает, что у картинки нет полупрозрачных пикселей. Конкретные типы
// stdlib (RGBA, NRGBA, YCbCr, Paletted, Gray) несут метод Opaque(); у типа без
// него считаем, что альфа есть — ошибка в эту сторону стоит лишних байт PNG, в
// обратную стёрла бы прозрачность.
func isOpaque(img image.Image) bool {
	o, ok := img.(interface{ Opaque() bool })
	return ok && o.Opaque()
}

// detectImageType возвращает whitelist-тип (image/png|image/jpeg) по сигнатуре
// содержимого или "" для всего остального. Не доверяет заголовку Content-Type.
func detectImageType(data []byte) string {
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case len(data) >= 3 && bytes.Equal(data[:3], []byte("\xff\xd8\xff")):
		return "image/jpeg"
	default:
		return ""
	}
}
