package visits

import (
	"bytes"
	"testing"
	"time"

	"github.com/google/uuid"
)

var (
	keySecret = []byte("dev-only-visitor-secret-not-real")
	keyForm   = uuid.MustParse("019f8daf-0db4-776d-82ba-01da0ed3853d")
	keyDay    = time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	chromeUA  = "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36"
)

// Один человек за одни сутки — один ключ, сколько бы раз он ни заходил. Ради этого
// числа всё и затевалось: «7 визитов» и «7 человек» — разные новости.
func TestVisitorKey_SamePersonSameDay(t *testing.T) {
	morning := visitorKey(keySecret, keyForm, "77.94.1.1", chromeUA, keyDay)
	evening := visitorKey(keySecret, keyForm, "77.94.1.1", chromeUA, keyDay.Add(9*time.Hour))

	if !bytes.Equal(morning, evening) {
		t.Fatal("ключи одного человека за одни сутки разошлись — уникальные будут завышены")
	}
	if len(morning) != visitorKeyLen {
		t.Fatalf("длина ключа = %d, ждали %d", len(morning), visitorKeyLen)
	}
}

// Соль суточная: завтра тот же человек — уже другой ключ. Это не дефект, а цена, за
// которую куплено право считать людей: вечного псевдонима не заводим.
func TestVisitorKey_RotatesDaily(t *testing.T) {
	today := visitorKey(keySecret, keyForm, "77.94.1.1", chromeUA, keyDay)
	tomorrow := visitorKey(keySecret, keyForm, "77.94.1.1", chromeUA, keyDay.AddDate(0, 0, 1))

	if bytes.Equal(today, tomorrow) {
		t.Fatal("ключ пережил сутки — это уже псевдоним посетителя, а не счётчик")
	}
}

// Разные формы — разные ключи у одного и того же человека: аудитории разных
// владельцев не сшиваются в одно множество.
func TestVisitorKey_DiffersPerForm(t *testing.T) {
	first := visitorKey(keySecret, keyForm, "77.94.1.1", chromeUA, keyDay)
	second := visitorKey(keySecret, uuid.New(), "77.94.1.1", chromeUA, keyDay)

	if bytes.Equal(first, second) {
		t.Fatal("ключ не зависит от формы — один посетитель сшил бы две аудитории")
	}
}

// Разные люди — разные ключи. Проверяются оба различающих признака по отдельности.
func TestVisitorKey_DiffersPerVisitor(t *testing.T) {
	base := visitorKey(keySecret, keyForm, "77.94.1.1", chromeUA, keyDay)

	otherIP := visitorKey(keySecret, keyForm, "8.8.8.8", chromeUA, keyDay)
	if bytes.Equal(base, otherIP) {
		t.Error("другой адрес дал тот же ключ")
	}
	otherUA := visitorKey(keySecret, keyForm, "77.94.1.1", "Mozilla/5.0 (iPhone) Safari/604.1", keyDay)
	if bytes.Equal(base, otherUA) {
		t.Error("другой браузер дал тот же ключ")
	}
}

// Секрет контура входит в соль: одинаковые данные на dev и на проде дают разные
// ключи. Иначе ключ был бы вычислим кем угодно, кто знает дату и адрес.
func TestVisitorKey_DependsOnSecret(t *testing.T) {
	ours := visitorKey(keySecret, keyForm, "77.94.1.1", chromeUA, keyDay)
	theirs := visitorKey([]byte("другой секрет контура"), keyForm, "77.94.1.1", chromeUA, keyDay)

	if bytes.Equal(ours, theirs) {
		t.Fatal("ключ не зависит от секрета контура")
	}
}

// Без адреса ключа нет: считать всех безадресных одним человеком — врать в меньшую
// сторону, каждого своим — в большую. Честнее не считать их вовсе.
func TestVisitorKey_NoAddressNoKey(t *testing.T) {
	if got := visitorKey(keySecret, keyForm, "", chromeUA, keyDay); got != nil {
		t.Fatalf("ключ без адреса = %x, ждали nil", got)
	}
	// Без секрета — тоже: контур, где он не настроен, уникальных не считает.
	if got := visitorKey(nil, keyForm, "77.94.1.1", chromeUA, keyDay); got != nil {
		t.Fatalf("ключ без секрета = %x, ждали nil", got)
	}
}

// Из ключа не восстановить ни адрес, ни агента: это односторонний хеш, а не
// шифротекст. Тест держит форму — 16 сырых байт без всякой структуры.
func TestVisitorKey_IsOpaque(t *testing.T) {
	key := visitorKey(keySecret, keyForm, "77.94.1.1", chromeUA, keyDay)
	if bytes.Contains(key, []byte("77.94")) || bytes.Contains(key, []byte("Chrome")) {
		t.Fatalf("в ключе видны исходные данные: %x", key)
	}
}
