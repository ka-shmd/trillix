package answerfiles

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

// Заголовок выдачи — граница безопасности, а не забота о букве «ё»: имя пришло от
// постороннего, и всё, чем можно разорвать заголовок на лишние параметры, обязано
// уехать в проценты.
func TestContentDisposition(t *testing.T) {
	got := contentDisposition(`отчёт; filename="evil.html`)

	if !strings.HasPrefix(got, "attachment; ") {
		t.Fatalf("выдача не вложением: %q", got)
	}
	// В ASCII-огрызке кавычки быть не может — она закрывает значение.
	ascii := got[strings.Index(got, `filename="`)+len(`filename="`):]
	ascii = ascii[:strings.IndexByte(ascii, '"')]
	if strings.ContainsAny(ascii, `"\/`) {
		t.Errorf("ASCII-имя несёт кавычку или слэш: %q", ascii)
	}

	star := got[strings.Index(got, "filename*=UTF-8''")+len("filename*=UTF-8''"):]
	for _, bad := range []string{";", "=", `"`, " ", ",", "\n"} {
		if strings.Contains(star, bad) {
			t.Errorf("filename* несёт %q, которым рвётся заголовок: %q", bad, star)
		}
	}
}

func TestContentDisposition_EmptyName(t *testing.T) {
	if got := contentDisposition("   "); !strings.Contains(got, `filename="file"`) {
		t.Errorf("пустое имя не заменено: %q", got)
	}
}

// Ключ формирует сервер целиком: имя клиента в нём не участвует, а расширение
// приезжает из белого списка.
func TestObjectKey(t *testing.T) {
	ws := uuid.MustParse("11111111-1111-7111-8111-111111111111")
	form := uuid.MustParse("22222222-2222-7222-8222-222222222222")
	id := uuid.MustParse("33333333-3333-7333-8333-333333333333")

	got := ObjectKey(ws, form, id, "pdf")
	want := "answers/" + ws.String() + "/" + form.String() + "/" + id.String() + ".pdf"
	if got != want {
		t.Fatalf("ключ = %q, ждали %q", got, want)
	}
}
