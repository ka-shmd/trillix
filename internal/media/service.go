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

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/forms"
)

const (
	// MaxImageBytes — потолок тела загрузки; handler ставит MaxBytesReader.
	MaxImageBytes = 5 << 20 // 5 МиБ
	// MaxImagePixels — гард площади до полного декода (decompression-bomb).
	MaxImagePixels = 24_000_000 // 24 Мпикс
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

// decodeReencode проверяет, что вход — PNG/JPEG, гардит площадь и пере-кодирует в
// канонические байты (снимая EXIF/GPS и нормализуя). Возвращает расширение,
// content-type и новые байты. Любая проблема входа → ErrValidation (422).
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

	var buf bytes.Buffer
	switch sniff {
	case "image/png":
		if err := png.Encode(&buf, img); err != nil {
			return "", "", nil, fmt.Errorf("encode png: %w", err)
		}
		return ".png", "image/png", buf.Bytes(), nil
	default: // image/jpeg
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: jpegQuality}); err != nil {
			return "", "", nil, fmt.Errorf("encode jpeg: %w", err)
		}
		return ".jpg", "image/jpeg", buf.Bytes(), nil
	}
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
