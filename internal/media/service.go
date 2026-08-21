package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	"image/jpeg" // именованный импорт регистрирует JPEG-декодер для image.Decode/DecodeConfig
	"image/png"  // и PNG-декодер
	"math"

	"github.com/google/uuid"
	"golang.org/x/image/draw"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
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
	PurposeBlock  Purpose = "block"
	PurposeCover  Purpose = "cover"
	PurposeLogo   Purpose = "logo"
	PurposeAvatar Purpose = "avatar"
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

// blobPutter — узкий интерфейс над S3-клиентом: кладёт объект. Публичное чтение
// идёт мимо приложения (Caddy→бакет), поэтому Get здесь не нужен.
type blobPutter interface {
	PutObject(ctx context.Context, bucket, key string, data []byte, contentType string) error
}

// Service — приём картинок. Хранилище скрыто за blobPutter, авторизация — за Forms.
type Service struct {
	forms  Forms
	blob   blobPutter
	bucket string
}

func NewService(f Forms, b blobPutter, bucket string) *Service {
	return &Service{forms: f, blob: b, bucket: bucket}
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
