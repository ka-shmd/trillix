package geo

import (
	"fmt"
	"net/netip"
	"strings"

	sypexgeo "github.com/night-codes/go-sypexgeo"
)

// Place — место визита. Пустой CountryCode означает «не определили»: адрес не
// нашёлся в справочнике, справочника нет вовсе или это IPv6 (формат Sypex Geo его
// не понимает — ADR §10, цена решения принята явно).
//
// Названия — русские, прямо из файла. Они ЗАМОРАЖИВАЮТСЯ в строке визита: если в
// новой версии справочника город переименуют, ранее собранные визиты сохранят
// прежнее имя. Это то же правило, по которому мета визита — контекст первого
// касания, а не последнего чтения.
type Place struct {
	CountryCode string // ISO 3166-1 alpha-2, верхним регистром
	Country     string
	City        string
}

// Empty — «место не определено».
func (p Place) Empty() bool { return p.CountryCode == "" }

// Service — открытый справочник. Потокобезопасен на чтение: файл загружен в
// память целиком и после открытия не меняется.
type Service struct {
	db *sypexgeo.SxGEO
}

// Open читает справочник. Пустой путь означает «гео на этом контуре нет» и даёт
// nil-сервис: это не ошибка, а штатная конфигурация dev-машины и prod-local.
//
// МИНА: sypexgeo.New при отсутствии файла или чужом формате вызывает panic, а не
// возвращает ошибку. Здесь она перехватывается и превращается в ошибку старта —
// иначе неверный GEO_DB_PATH ронял бы весь api вместо честного «файл не читается».
func Open(path string) (svc *Service, err error) {
	if strings.TrimSpace(path) == "" {
		return nil, nil
	}
	defer func() {
		if r := recover(); r != nil {
			svc, err = nil, fmt.Errorf("open geo database %s: %v", path, r)
		}
	}()
	db := sypexgeo.New(path)
	return &Service{db: &db}, nil
}

// Configured — открыт ли справочник на этом контуре. Нужен экрану: без справочника
// блок стран и городов не рисуется вовсе, а со справочником, но без единого
// определённого места, рисуется с объяснением. Разница видна только серверу:
// пустой список одинаков в обоих случаях, а означает разное.
func (s *Service) Configured() bool { return s != nil && s.db != nil }

// Lookup определяет место по адресу. Ошибок наружу не отдаёт вовсе: аналитика не
// имеет права ни уронить приём бикона, ни заставить вызывающего разбирать, почему
// адрес не нашёлся. Не нашёлся — значит место пустое.
//
// nil-сервис (гео не настроено) отвечает пустым местом, поэтому вызывающему не
// нужна ветка «а есть ли у нас гео».
func (s *Service) Lookup(ip string) Place {
	if s == nil || s.db == nil {
		return Place{}
	}
	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil || !addr.IsValid() {
		return Place{}
	}
	// IPv6 справочник не понимает (вернёт ошибку «IP out of range»), а приватные
	// адреса в нём отсутствуют по смыслу — оба случая штатны и молчаливы.
	if !addr.Is4() || addr.IsPrivate() || addr.IsLoopback() {
		return Place{}
	}

	res, err := s.db.Info(addr.String())
	if err != nil {
		return Place{}
	}
	return Place{
		CountryCode: strings.ToUpper(res.Country.ISO),
		Country:     res.Country.NameRu,
		City:        res.City.NameRu,
	}
}
