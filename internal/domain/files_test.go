package domain

import "testing"

// Белый список — граница безопасности, и проверяется она с двух сторон: что
// разрешённое разрешено и что опасное не проходит НИ ПОД КАКИМ MIME.
func TestLookupFileType(t *testing.T) {
	ok := map[string]string{
		"application/pdf":           "pdf",
		"image/jpeg":                "jpg",
		"text/plain; charset=utf-8": "txt", // параметры и регистр отбрасываются
		"IMAGE/PNG":                 "png",
		"application/vnd.ms-excel":  "xls",
		"application/zip":           "zip",
	}
	for mime, ext := range ok {
		got, allowed := LookupFileType(mime)
		if !allowed {
			t.Errorf("%s: не разрешён, а должен", mime)
			continue
		}
		if got.Ext != ext {
			t.Errorf("%s: расширение %q, ждали %q", mime, got.Ext, ext)
		}
	}

	// Ровно тот список, ради которого поле файла вообще опасно: документ со
	// скриптами, разметка и исполняемое.
	for _, mime := range []string{
		"image/svg+xml", "text/html", "application/xhtml+xml", "application/javascript",
		"application/wasm", "application/x-msdownload", "application/octet-stream", "",
	} {
		if _, allowed := LookupFileType(mime); allowed {
			t.Errorf("%s: разрешён, а не должен", mime)
		}
	}
}

// Ни один разрешённый тип не даёт запрещённого расширения. Тест держит инвариант в
// том виде, в котором его нельзя обойти правкой одной строки белого списка.
func TestAllowedTypesCarryNoDeniedExtension(t *testing.T) {
	for mime, ft := range allowedFileTypes {
		if _, denied := deniedExtensions[ft.Ext]; denied {
			t.Errorf("%s даёт запрещённое расширение %q", mime, ft.Ext)
		}
		if !validFileFamily(string(ft.Family)) {
			t.Errorf("%s: неизвестное семейство %q", mime, ft.Family)
		}
	}
}

func TestFamilyAllowed(t *testing.T) {
	if !FamilyAllowed(nil, FileImage) {
		t.Error("пустой accept обязан пускать всё")
	}
	if !FamilyAllowed([]string{"document", "image"}, FileImage) {
		t.Error("перечисленное семейство обязано проходить")
	}
	if FamilyAllowed([]string{"document"}, FileImage) {
		t.Error("неперечисленное семейство проходить не должно")
	}
}
