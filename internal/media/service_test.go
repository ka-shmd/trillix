package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"hash/crc32"
	"image"
	"image/png"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/forms"
)

type fakeForms struct {
	form forms.Form
	err  error
}

func (f fakeForms) Get(context.Context, uuid.UUID, uuid.UUID) (forms.Form, error) {
	return f.form, f.err
}

type fakeBlob struct {
	called                   bool
	bucket, key, contentType string
	data                     []byte
}

func (b *fakeBlob) PutObject(_ context.Context, bucket, key string, data []byte, contentType string) error {
	b.called = true
	b.bucket, b.key, b.contentType = bucket, key, contentType
	b.data = data
	return nil
}

// makePNG кодирует настоящую w×h PNG-картинку (валидные байты для декода).
func makePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// makePNGHeader собирает PNG только с сигнатурой и IHDR, объявляющим w×h. Для гард-
// теста площади: image.DecodeConfig читает размеры из IHDR, не декодируя пиксели.
func makePNGHeader(w, h uint32) []byte {
	var b bytes.Buffer
	b.Write([]byte("\x89PNG\r\n\x1a\n"))
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // color type RGBA
	length := make([]byte, 4)
	binary.BigEndian.PutUint32(length, uint32(len(ihdr)))
	b.Write(length)
	crcInput := append([]byte("IHDR"), ihdr...)
	b.WriteString("IHDR")
	b.Write(ihdr)
	crc := make([]byte, 4)
	binary.BigEndian.PutUint32(crc, crc32.ChecksumIEEE(crcInput))
	b.Write(crc)
	return b.Bytes()
}

func TestUpload_Success(t *testing.T) {
	ws := uuid.New()
	blobStore := &fakeBlob{}
	svc := NewService(fakeForms{form: forms.Form{WorkspaceID: ws}}, blobStore, "app-media")

	key, err := svc.Upload(context.Background(), uuid.New(), uuid.New(), makePNG(t, 2, 2))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if !strings.HasPrefix(key, ws.String()+"/") || !strings.HasSuffix(key, ".png") {
		t.Fatalf("ключ %q: ожидался вид <workspaceID>/<hash>.png", key)
	}
	if !blobStore.called || blobStore.bucket != "app-media" || blobStore.contentType != "image/png" {
		t.Fatalf("blob вызван неверно: called=%v bucket=%q ct=%q", blobStore.called, blobStore.bucket, blobStore.contentType)
	}
	// Ключ контент-адресный: hash в имени = sha256 сохранённых (ре-энкоднутых) байт.
	sum := sha256.Sum256(blobStore.data)
	wantKey := ws.String() + "/" + hex.EncodeToString(sum[:]) + ".png"
	if key != wantKey {
		t.Fatalf("ключ %q ≠ контент-хэш %q", key, wantKey)
	}
	// Сохранённые байты — валидная PNG (ре-энкод состоялся).
	if _, err := png.Decode(bytes.NewReader(blobStore.data)); err != nil {
		t.Fatalf("сохранённые байты не декодируются как PNG: %v", err)
	}
}

func TestUpload_AuthDeniedSkipsBlob(t *testing.T) {
	blobStore := &fakeBlob{}
	svc := NewService(fakeForms{err: domain.ErrNotFound}, blobStore, "app-media")

	_, err := svc.Upload(context.Background(), uuid.New(), uuid.New(), makePNG(t, 2, 2))
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, ожидалось ErrNotFound", err)
	}
	if blobStore.called {
		t.Fatal("blob не должен вызываться при отказе доступа (байты не обрабатываются)")
	}
}

func TestUpload_RejectsNonImage(t *testing.T) {
	blobStore := &fakeBlob{}
	svc := NewService(fakeForms{form: forms.Form{WorkspaceID: uuid.New()}}, blobStore, "app-media")

	_, err := svc.Upload(context.Background(), uuid.New(), uuid.New(), []byte("это не картинка"))
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, ожидалось ErrValidation", err)
	}
	if blobStore.called {
		t.Fatal("blob не должен вызываться для невалидного входа")
	}
}

func TestDecodeReencode(t *testing.T) {
	t.Run("PNG ре-энкодится", func(t *testing.T) {
		ext, ct, out, err := decodeReencode(makePNG(t, 3, 3))
		if err != nil {
			t.Fatalf("decodeReencode: %v", err)
		}
		if ext != ".png" || ct != "image/png" || len(out) == 0 {
			t.Fatalf("ext=%q ct=%q len=%d", ext, ct, len(out))
		}
	})

	t.Run("не-картинка отклоняется", func(t *testing.T) {
		if _, _, _, err := decodeReencode([]byte("GIF89a...")); !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("err = %v, ожидалось ErrValidation", err)
		}
	})

	t.Run("превышение площади отклоняется", func(t *testing.T) {
		// 6000×5000 = 30 Мпикс > MaxImagePixels; отсекается на DecodeConfig без декода.
		if _, _, _, err := decodeReencode(makePNGHeader(6000, 5000)); !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("err = %v, ожидалось ErrValidation", err)
		}
	})
}
