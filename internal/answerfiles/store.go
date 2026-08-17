package answerfiles

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/blob"
)

// Сроки подписей. Оба короткие и по разным причинам: адрес загрузки живёт
// столько, сколько разумно грузить файл с телефона, адрес скачивания — столько,
// сколько нужно браузеру перейти по редиректу. Presigned-адрес это учётные
// данные, и его срок — единственное, что ограничивает утёкшую ссылку.
const (
	PutTTL = 5 * time.Minute
	GetTTL = time.Minute
)

// blobStore — то, что модулю нужно от слоя-1. Интерфейс объявлен ПОТРЕБИТЕЛЕМ
// (конвенция internal/CLAUDE.md): весь blob.Client сюда не тянется.
type blobStore interface {
	PresignPut(bucket, key string, opt blob.PutOptions, now time.Time) (string, error)
	PresignGet(bucket, key string, opt blob.GetOptions, now time.Time) (string, error)
	HeadObject(ctx context.Context, bucket, key string) (blob.ObjectInfo, error)
	DeleteObject(ctx context.Context, bucket, key string) error
}

// Store — политика бакета файлов ответов: схема ключей, сроки подписей, правила
// выдачи. Слой-2 подсистемы хранилища (docs/S3.md §3), сосед media.
type Store struct {
	blob   blobStore
	bucket string
	now    func() time.Time
}

func NewStore(b blobStore, bucket string) *Store {
	return &Store{blob: b, bucket: bucket, now: time.Now}
}

// ObjectKey — адрес объекта. Формирует его СЕРВЕР целиком: имя, присланное
// клиентом, не участвует ни в каком виде, иначе «../» и юникодные разделители
// стали бы нашей заботой. Расширение берётся из белого списка по разрешённому
// MIME, а не из присланного имени.
//
// Воркспейс и форма в пути — не для доступа (его даёт подпись), а для человека с
// консолью хранилища: по ключу видно, чьё это и откуда.
func ObjectKey(workspaceID, formID, fileID uuid.UUID, ext string) string {
	return fmt.Sprintf("answers/%s/%s/%s.%s", workspaceID, formID, fileID, ext)
}

// UploadURL — адрес для загрузки одного файла. Размер и тип входят в подпись:
// запрос с другими значениями хранилище отвергнет само, и это единственный
// механизм, который держит потолок, — байты к нам не приходят.
func (s *Store) UploadURL(key, contentType string, size int64) (string, error) {
	return s.blob.PresignPut(s.bucket, key, blob.PutOptions{
		ContentType:   contentType,
		ContentLength: size,
		Expires:       PutTTL,
	}, s.now())
}

// DownloadURL — адрес для скачивания. Оба переопределения обязательны и не
// косметические: пользовательский файл обязан СКАЧИВАТЬСЯ, а не открываться в
// origin хранилища. Content-Type объекта при выдаче игнорируется намеренно — он
// пришёл от того же, кто прислал файл.
func (s *Store) DownloadURL(key, filename string) (string, error) {
	return s.blob.PresignGet(s.bucket, key, blob.GetOptions{
		Expires:             GetTTL,
		ResponseContentType: "application/octet-stream",
		ResponseDisposition: contentDisposition(filename),
	}, s.now())
}

// Size — настоящий размер объекта. Спрашивается у хранилища, потому что байты
// клал браузер: заявленному при выдаче слота размеру верить нечему.
func (s *Store) Size(ctx context.Context, key string) (int64, error) {
	info, err := s.blob.HeadObject(ctx, s.bucket, key)
	if err != nil {
		return 0, err
	}
	return info.Size, nil
}

// Remove сносит объект. Зовётся ДО удаления строки: строка уносит с собой ключ.
func (s *Store) Remove(ctx context.Context, key string) error {
	return s.blob.DeleteObject(ctx, s.bucket, key)
}

// contentDisposition — заголовок выдачи файла. Два представления имени по RFC
// 6266/5987: ASCII-огрызок для древних клиентов и filename* с процентным
// кодированием UTF-8 для всех остальных.
//
// Кодирование здесь — не забота о букве «ё», а граница безопасности: имя пришло
// от постороннего, и кавычка, перевод строки или точка с запятой в нём иначе
// разорвали бы заголовок. Кодируется всё, кроме unreserved, — то есть разорвать
// нечем.
func contentDisposition(filename string) string {
	name := strings.TrimSpace(filename)
	if name == "" {
		name = "file"
	}
	ascii := strings.Map(func(r rune) rune {
		if r < 32 || r > 126 || r == '"' || r == '\\' || r == '/' {
			return '_'
		}
		return r
	}, name)
	return fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s", ascii, rfc5987Escape(name))
}

// rfc5987Escape — процентное кодирование для filename*. Своё, а не url.PathEscape:
// та оставляет как есть sub-delims, среди которых «;» и «=», то есть ровно то, чем
// заголовок разрывается на лишние параметры. Здесь разрешён только attr-char из
// RFC 5987, остальное — %XX.
func rfc5987Escape(s string) string {
	const attrChar = "!#$&+-.^_`|~"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			strings.IndexByte(attrChar, c) >= 0:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
