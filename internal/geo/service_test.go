package geo

import (
	"os"
	"path/filepath"
	"testing"
)

// Пустой путь — не ошибка, а штатная конфигурация контура без гео: dev-машина и
// prod-local живут без справочника, и падать на старте им не за что.
func TestOpen_EmptyPathIsNoGeo(t *testing.T) {
	svc, err := Open("")
	if err != nil {
		t.Fatalf("неожиданная ошибка: %v", err)
	}
	if svc != nil {
		t.Fatal("пустой путь обязан дать nil-сервис")
	}
	// nil-сервис отвечает пустым местом, а не паникует: у вызывающего не должно
	// быть ветки «а настроено ли гео».
	if got := svc.Lookup("8.8.8.8"); !got.Empty() {
		t.Fatalf("место = %+v, ждали пустое", got)
	}
}

// МИНА библиотеки: sypexgeo.New на отсутствующем файле вызывает panic. Она обязана
// стать ошибкой старта — иначе опечатка в GEO_DB_PATH роняет весь api.
func TestOpen_MissingFileIsError(t *testing.T) {
	svc, err := Open("/nonexistent/SxGeoCity.dat")
	if err == nil {
		t.Fatal("отсутствующий файл обязан дать ошибку, а не панику или nil")
	}
	if svc != nil {
		t.Fatal("при ошибке сервис не возвращается")
	}
}

// Чужой формат — тоже ошибка старта, а не паника.
func TestOpen_WrongFormatIsError(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "fake*.dat")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("это не справочник, а просто текст подходящей длины"); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	if _, err := Open(f.Name()); err == nil {
		t.Fatal("чужой формат обязан дать ошибку")
	}
}

// Адреса, по которым места быть не может. Каждый — свой случай, и все три
// молчаливы: аналитика не имеет права ни уронить приём бикона, ни объяснять
// вызывающему, почему адрес не нашёлся.
func TestLookup_NoPlaceCases(t *testing.T) {
	// Сервис с непрочитанным справочником ведёт себя как отсутствующий.
	svc := &Service{}
	for _, ip := range []string{
		"",                // заголовка не было
		"не адрес",        // мусор
		"127.0.0.1",       // локальный
		"192.168.1.10",    // приватный
		"2a02:6b8::2:242", // IPv6 — формат Sypex Geo его не понимает
	} {
		if got := svc.Lookup(ip); !got.Empty() {
			t.Errorf("Lookup(%q) = %+v, ждали пустое место", ip, got)
		}
	}
}

// Проверка против НАСТОЯЩЕГО справочника. Файл весит 37 МБ и в репозиторий не
// кладётся, поэтому тест пропускается, если путь не задан:
//
//	GEO_DB_PATH=/путь/SxGeoCity.dat go test ./internal/geo/
//
// Он единственный доказывает, что библиотека понимает сегодняшний формат файла и
// что имена приезжают по-русски, — ради этого свойства справочник и выбран.
func TestLookup_RealDatabase(t *testing.T) {
	path := os.Getenv("GEO_DB_PATH")
	if path == "" {
		t.Skip("GEO_DB_PATH не задан — справочника на этой машине нет")
	}
	// go test запускается в каталоге ПАКЕТА, а рабочий путь контура (geo/SxGeoCity.dat)
	// отсчитывается от корня репозитория: относительный путь здесь не откроется, и
	// падение говорило бы о рабочем каталоге, а не о справочнике.
	if !filepath.IsAbs(path) {
		t.Skipf("GEO_DB_PATH=%q относительный: для этого теста нужен абсолютный путь", path)
	}
	svc, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	tests := []struct {
		ip      string
		code    string
		country string
		city    string
	}{
		{ip: "77.94.1.1", code: "RU", country: "Россия", city: "Москва"},
		{ip: "8.8.8.8", code: "US", country: "США", city: "Маунтин-Вью"},
	}
	for _, tt := range tests {
		got := svc.Lookup(tt.ip)
		if got.CountryCode != tt.code || got.Country != tt.country || got.City != tt.city {
			t.Errorf("Lookup(%s) = %+v, ждали %s/%s/%s", tt.ip, got, tt.code, tt.country, tt.city)
		}
	}
}
