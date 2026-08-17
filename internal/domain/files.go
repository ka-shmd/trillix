package domain

import (
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxFileNameLen — длина имени файла, в рунах. Имя показывается автору в таблице
// ответов и уезжает в Content-Disposition; двести рун — это уже не имя, а способ
// сломать вёрстку строки.
const MaxFileNameLen = 200

// Что вообще можно приложить к ответу (фаза 24, design/answer-files.md §5).
//
// Это граница безопасности, а не удобство: список белый, и автор формы выбирает
// ВНУТРИ него (Settings.Accept), а не расширяет его. Разрешение на новый тип —
// правка этого файла, то есть код и ревью, а не настройка в интерфейсе.
//
// Файлы ответов у нас нигде не декодируются и не распаковываются — ни картинка, ни
// архив (в отличие от internal/media, который картинки пересобирает). Первый, кто
// добавит «превью в таблице ответов», откроет декодер для чужих байтов.

// FileFamily — семейство типов, которым автор формы описывает «что принимаю».
type FileFamily string

const (
	FileImage    FileFamily = "image"
	FileDocument FileFamily = "document"
	FileTable    FileFamily = "table"
	FileArchive  FileFamily = "archive"
)

// FileFamilies — все семейства одним списком, он же источник проверки схемы и
// порядок для интерфейса.
var FileFamilies = []FileFamily{FileImage, FileDocument, FileTable, FileArchive}

// FileType — разрешённый тип: MIME, каким его объявляет браузер, и расширение,
// которое получит объект в бакете. Расширение берётся ОТСЮДА, а не из имени,
// присланного клиентом.
type FileType struct {
	MIME   string
	Ext    string
	Family FileFamily
}

// allowedFileTypes — белый список. Ключ — MIME из заголовка загрузки.
//
// Чего здесь нет и не будет: image/svg+xml (это документ со скриптами, а не
// картинка), text/html, application/xhtml+xml, application/javascript, wasm и любой
// исполняемый формат. Отдаём мы их вложением и с чужого домена, но полагаться на
// одну меру там, где дёшево иметь три, — плохая сделка.
var allowedFileTypes = map[string]FileType{
	"image/png":  {MIME: "image/png", Ext: "png", Family: FileImage},
	"image/jpeg": {MIME: "image/jpeg", Ext: "jpg", Family: FileImage},
	"image/webp": {MIME: "image/webp", Ext: "webp", Family: FileImage},
	"image/heic": {MIME: "image/heic", Ext: "heic", Family: FileImage},

	"application/pdf": {MIME: "application/pdf", Ext: "pdf", Family: FileDocument},
	"application/msword": {
		MIME: "application/msword", Ext: "doc", Family: FileDocument,
	},
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
		MIME: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		Ext:  "docx", Family: FileDocument,
	},
	"application/vnd.oasis.opendocument.text": {
		MIME: "application/vnd.oasis.opendocument.text", Ext: "odt", Family: FileDocument,
	},
	"text/plain": {MIME: "text/plain", Ext: "txt", Family: FileDocument},

	"text/csv":                 {MIME: "text/csv", Ext: "csv", Family: FileTable},
	"application/vnd.ms-excel": {MIME: "application/vnd.ms-excel", Ext: "xls", Family: FileTable},
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
		MIME: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		Ext:  "xlsx", Family: FileTable,
	},
	"application/vnd.oasis.opendocument.spreadsheet": {
		MIME: "application/vnd.oasis.opendocument.spreadsheet", Ext: "ods", Family: FileTable,
	},

	"application/zip": {MIME: "application/zip", Ext: "zip", Family: FileArchive},
}

// deniedExtensions — расширения, которые не должны получиться НИКОГДА, чем бы ни
// стал белый список завтра. Отдельная проверка держит инвариант в том виде, в
// котором его можно проверить тестом: «в белом списке нет ни одного из этих».
var deniedExtensions = map[string]struct{}{
	"svg": {}, "html": {}, "htm": {}, "xhtml": {}, "js": {}, "mjs": {}, "wasm": {},
	"exe": {}, "dll": {}, "bat": {}, "cmd": {}, "com": {}, "sh": {}, "jar": {},
	"msi": {}, "apk": {}, "scr": {}, "vbs": {}, "ps1": {},
}

// LookupFileType возвращает разрешённый тип по MIME. Второй результат false —
// «такое мы не принимаем»; различать «неизвестный» и «запрещённый» наружу не нужно.
func LookupFileType(mime string) (FileType, bool) {
	t, ok := allowedFileTypes[normalizeMIME(mime)]
	if !ok {
		return FileType{}, false
	}
	if _, denied := deniedExtensions[t.Ext]; denied {
		return FileType{}, false
	}
	return t, true
}

// FamilyAllowed — пускает ли вопрос файлы этого семейства. Пустой accept у блока
// означает «все разрешённые продуктом», а не «никакие»: блок, у которого автор
// ничего не выбирал, обязан работать.
func FamilyAllowed(accept []string, family FileFamily) bool {
	if len(accept) == 0 {
		return true
	}
	for _, a := range accept {
		if FileFamily(a) == family {
			return true
		}
	}
	return false
}

// validFileFamily — известное семейство (проверка схемы).
func validFileFamily(v string) bool {
	for _, f := range FileFamilies {
		if FileFamily(v) == f {
			return true
		}
	}
	return false
}

// normalizeMIME отбрасывает параметры («text/plain; charset=utf-8») и регистр:
// браузеры присылают и то и другое, а ключ белого списка один.
func normalizeMIME(mime string) string {
	if i := strings.IndexByte(mime, ';'); i >= 0 {
		mime = mime[:i]
	}
	return strings.ToLower(strings.TrimSpace(mime))
}

// SanitizeFileName приводит присланное имя к тому, что можно хранить и показывать.
//
// Имя — ДАННЫЕ, а не путь: в ключ объекта оно не попадает (его формирует сервер),
// поэтому здесь не «защита от traversal», а гигиена показа. Убирается то, чем имя
// врёт или ломает: управляющие символы (перевод строки в заголовке выдачи),
// разделители пути (иначе автор увидит в таблице «../../etc/passwd» и решит, что
// у нас дыра) и пустота.
func SanitizeFileName(name string) string {
	if !utf8.ValidString(name) {
		return "file"
	}
	cleaned := strings.Map(func(r rune) rune {
		switch {
		case r == '/' || r == '\\':
			return '_'
		case unicode.IsControl(r):
			return -1
		default:
			return r
		}
	}, name)
	cleaned = strings.TrimSpace(cleaned)
	// Точки в начале прячут файл в unix-листинге и делают «..» именем каталога.
	cleaned = strings.TrimLeft(cleaned, ".")
	if r := []rune(cleaned); len(r) > MaxFileNameLen {
		cleaned = string(r[:MaxFileNameLen])
	}
	if strings.TrimSpace(cleaned) == "" {
		return "file"
	}
	return cleaned
}

// FileAnswers — какие загрузки названы в ответе, по блокам: block_id → id файлов.
// Только у блоков типа file и только у тех, что есть в схеме, — то есть ровно то,
// что приём ответа обязан сверить с базой и хранилищем.
//
// Отдельной функцией, а не разбором по месту: приём ответа делает с этим списком
// три разные вещи (проверка, заявление, откат), и три независимых обхода схемы
// однажды разошлись бы в том, что считать файлом.
func FileAnswers(schema FormSchema, answers map[string]json.RawMessage) map[string][]string {
	out := map[string][]string{}
	for i := range schema.Blocks {
		b := schema.Blocks[i]
		if b.Type != BlockFile {
			continue
		}
		raw, ok := answers[b.ID]
		if !ok || len(raw) == 0 {
			continue
		}
		var ids []string
		if json.Unmarshal(raw, &ids) != nil || len(ids) == 0 {
			continue
		}
		out[b.ID] = ids
	}
	return out
}

// AnswerFile — что о приложенном файле знает кабинет, не открывая его. Живёт в
// домене, а не в модуле хранения: этим типом ОБЩАЮТСЯ два модуля (answerfiles
// отдаёт, submissions показывает), и объявленный у любого из них он развернул бы
// направление зависимости.
type AnswerFile struct {
	Name string
	Size int64
}
