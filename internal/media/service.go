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
	// jpegQuality — качество при ре-энкоде JPEG.
	jpegQuality = 85
)

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

// Upload авторизует членство, валидирует и нормализует картинку (ре-энкод снимает
// EXIF/GPS) и кладёт её в бакет, возвращая стабильный ключ
// workspaceID/<sha256>.<ext>. Порядок: сначала проверка доступа (инвариант 1),
// затем обработка байтов. Контент-адресный ключ делает PUT идемпотентным (дедуп).
func (s *Service) Upload(ctx context.Context, userID, formID uuid.UUID, data []byte) (string, error) {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return "", err // ErrNotFound для чужой/несуществующей — не раскрываем приватное
	}

	ext, contentType, canonical, err := decodeReencode(data)
	if err != nil {
		return "", err
	}

	sum := sha256.Sum256(canonical)
	key := fmt.Sprintf("%s/%s%s", form.WorkspaceID, hex.EncodeToString(sum[:]), ext)

	if err := s.blob.PutObject(ctx, s.bucket, key, canonical, contentType); err != nil {
		return "", fmt.Errorf("put media object: %w", err)
	}
	return key, nil
}

// decodeReencode проверяет, что вход — PNG/JPEG, гардит площадь, уменьшает картинку
// до MaxImageWidth и пере-кодирует в канонические байты (снимая EXIF/GPS и
// нормализуя). Возвращает расширение, content-type и новые байты. Любая проблема
// входа → ErrValidation (422).
func decodeReencode(data []byte) (ext, contentType string, out []byte, err error) {
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

	return encodeCanonical(downscale(img))
}

// downscale уменьшает картинку до MaxImageWidth по ширине, сохраняя пропорции.
// Только уменьшает: то, что уже уже потолка (логотип, узкая высокая полоса),
// возвращается нетронутым — апскейл добавил бы байт, не добавив деталей.
func downscale(img image.Image) image.Image {
	b := img.Bounds()
	if b.Dx() <= MaxImageWidth {
		return img
	}
	h := int(math.Round(float64(b.Dy()) * float64(MaxImageWidth) / float64(b.Dx())))
	if h < 1 {
		h = 1 // очень широкая полоса: высота не должна схлопнуться в ноль
	}
	dst := image.NewRGBA(image.Rect(0, 0, MaxImageWidth, h))
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
	// BestCompression, а не дефолт: PNG здесь конкурирует с JPEG за размер, и
	// проигранные им байты означают ухудшение картинки там, где оно не нужно.
	pngEnc := png.Encoder{CompressionLevel: png.BestCompression}
	var pngBuf bytes.Buffer
	if err := pngEnc.Encode(&pngBuf, img); err != nil {
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
