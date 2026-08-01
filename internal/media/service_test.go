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
	"image/color"
	"image/draw"
	"image/png"
	"math/rand"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
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

// makeOpaquePNG кодирует непрозрачную одноцветную PNG: плоская заливка сжимается
// PNG'ом в сотни байт, а JPEG на ней проигрывает — образец «графика, а не фото».
func makeOpaquePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.RGBA{R: 30, G: 90, B: 200, A: 255}}, image.Point{}, draw.Src)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// makeNoisePNG кодирует непрозрачную PNG из детерминированного шума: PNG на шуме
// сжать нечем (размер ≈ сырые пиксели), JPEG выигрывает кратно — образец «фото».
// Сид фиксирован: тест обязан быть детерминированным (PROCESS §3).
func makeNoisePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	rng := rand.New(rand.NewSource(42))
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.SetRGBA(x, y, color.RGBA{
				R: uint8(rng.Intn(256)), G: uint8(rng.Intn(256)), B: uint8(rng.Intn(256)), A: 255,
			})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// decodedSize возвращает размеры картинки в сохранённых байтах.
func decodedSize(t *testing.T, data []byte) (w, h int) {
	t.Helper()
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("сохранённые байты не читаются как картинка: %v", err)
	}
	return cfg.Width, cfg.Height
}

func TestDownscale(t *testing.T) {
	// Кап только по ширине и только вниз. Третий случай — тот, ради которого кап
	// не по длинной стороне: у высокого портрета длинная сторона — высота, и её
	// кап срезал бы ШИРИНУ до 640, сделав картинку недоразрешённой для колонки 700.
	tests := []struct {
		name         string
		w, h         int
		wantW, wantH int
	}{
		{"широкая уменьшается по ширине", 3000, 2000, MaxImageWidth, 933},
		{"фото с телефона", 4032, 3024, MaxImageWidth, 1050},
		{"высокий портрет не трогается", 1200, 3000, 1200, 3000},
		{"логотип не апскейлится", 300, 120, 300, 120},
		{"ровно по потолку не трогается", MaxImageWidth, 800, MaxImageWidth, 800},
		{"очень широкая полоса не схлопывает высоту", 20000, 5, MaxImageWidth, 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := downscale(image.NewRGBA(image.Rect(0, 0, tc.w, tc.h)))
			if got.Bounds().Dx() != tc.wantW || got.Bounds().Dy() != tc.wantH {
				t.Fatalf("%d×%d → %d×%d, ожидалось %d×%d",
					tc.w, tc.h, got.Bounds().Dx(), got.Bounds().Dy(), tc.wantW, tc.wantH)
			}
		})
	}
}

func TestEncodeCanonical_ФорматПоСодержимому(t *testing.T) {
	t.Run("полупрозрачная остаётся PNG, даже когда PNG крупно проигрывает", func(t *testing.T) {
		// Фикстура выбрана так, чтобы тест МОГ покраснеть. Пустая прозрачная
		// картинка для этого не годится: на ней PNG меньше JPEG и без гарда альфы,
		// поэтому удаление гарда такой тест не ловит (проверено мутацией — проходил).
		// Здесь наоборот: полупрозрачный шум, на котором PNG проигрывает JPEG в
		// разы, и единственная причина остаться PNG — что терять альфу нельзя.
		img := image.NewNRGBA(image.Rect(0, 0, 400, 400))
		rng := rand.New(rand.NewSource(1))
		for y := range 400 {
			for x := range 400 {
				img.SetNRGBA(x, y, color.NRGBA{
					R: uint8(rng.Intn(256)), G: uint8(rng.Intn(256)), B: uint8(rng.Intn(256)), A: 128,
				})
			}
		}
		ext, ct, _, err := encodeCanonical(img)
		if err != nil {
			t.Fatalf("encodeCanonical: %v", err)
		}
		if ext != ".png" || ct != "image/png" {
			t.Fatalf("ext=%q ct=%q, ожидался PNG: JPEG не умеет альфу и залил бы прозрачное фоном", ext, ct)
		}
	})

	t.Run("непрозрачная плоская графика остаётся PNG", func(t *testing.T) {
		img, _, err := image.Decode(bytes.NewReader(makeOpaquePNG(t, 400, 400)))
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		ext, _, out, err := encodeCanonical(img)
		if err != nil {
			t.Fatalf("encodeCanonical: %v", err)
		}
		if ext != ".png" {
			t.Fatalf("ext=%q (%d байт), ожидался .png: на плоской заливке PNG меньше и без потерь", ext, len(out))
		}
	})

	t.Run("непрозрачное фото уезжает в JPEG", func(t *testing.T) {
		img, _, err := image.Decode(bytes.NewReader(makeNoisePNG(t, 400, 400)))
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		ext, ct, out, err := encodeCanonical(img)
		if err != nil {
			t.Fatalf("encodeCanonical: %v", err)
		}
		if ext != ".jpg" || ct != "image/jpeg" {
			t.Fatalf("ext=%q ct=%q (%d байт), ожидался JPEG: PNG поверх фото и есть разбираемая проблема", ext, ct, len(out))
		}
	})
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

// Сквозной случай, ради которого задача и делалась: фотография с телефона
// доезжает до бакета уменьшенной и в JPEG, а не мегабайтной PNG в исходном
// разрешении. Проверяем то, что реально уедет пользователю, — сохранённые байты.
func TestUpload_ФотоУменьшаетсяИМеняетФормат(t *testing.T) {
	ws := uuid.New()
	blobStore := &fakeBlob{}
	svc := NewService(fakeForms{form: forms.Form{WorkspaceID: ws}}, blobStore, "app-media")

	src := makeNoisePNG(t, 3000, 2250)
	key, err := svc.Upload(context.Background(), uuid.New(), uuid.New(), src)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}

	// 2250 × 1400/3000 = 1050: пропорции сохранены.
	w, h := decodedSize(t, blobStore.data)
	if w != MaxImageWidth || h != 1050 {
		t.Fatalf("сохранено %d×%d, ожидалось %d×1050", w, h, MaxImageWidth)
	}
	if !strings.HasSuffix(key, ".jpg") || blobStore.contentType != "image/jpeg" {
		t.Fatalf("key=%q ct=%q, ожидался JPEG", key, blobStore.contentType)
	}
	if len(blobStore.data) >= len(src) {
		t.Fatalf("сохранено %d байт при исходных %d — картинка не полегчала", len(blobStore.data), len(src))
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
