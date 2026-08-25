package domain

import "strings"

// Разбор user-agent для экрана визитов: семейство браузера, ОС и тип устройства.
//
// Свой разбор, а не библиотека: список зависимостей заморожен, а нужны три
// десятка подстрок и один порядок проверок. Точность здесь заведомо неполная и
// это нормально — метрика показывает пропорции («85 % десктопа»), а не опознаёт
// конкретного человека.
//
// Разбор идёт НА ЧТЕНИИ, а не при записи визита, и это несущее решение: SQL
// группирует по строке user-agent (их у формы сотни, а не по одной на визит),
// Go разбирает уже сгруппированное. Отсюда два следствия — колонки и миграции
// не нужны, а улучшенный парсер чинит УЖЕ СОБРАННЫЕ данные, а не только будущие.

// DeviceKind — вид устройства. Значения уезжают на экран как есть.
type DeviceKind string

const (
	DeviceDesktop DeviceKind = "desktop"
	DeviceMobile  DeviceKind = "mobile"
	DeviceTablet  DeviceKind = "tablet"
	// DeviceBot — краулеры и роботы. Отдельный вид, а не «прочее»: их визиты
	// портят пропорции живых людей, и владелец должен видеть их отдельной строкой,
	// а не искать в десктопе.
	DeviceBot DeviceKind = "bot"
)

// UserAgent — то, что мы умеем достать из строки. Пустая строка в любом поле
// означает «не опознали» — экран покажет это отдельной строкой, а не припишет
// к соседней.
type UserAgent struct {
	Browser string
	OS      string
	Device  DeviceKind
}

// botMarkers — подстроки, по которым узнаётся робот. Проверяются ПЕРВЫМИ: почти
// каждый краулер представляется поверх обычного браузерного user-agent, и без
// этого порядка Googlebot попал бы в Safari на десктопе.
var botMarkers = []string{"bot", "crawler", "spider", "crawling", "headlesschrome", "python-requests", "curl/", "wget/", "yandex.com/bots"}

// browserMarkers — семейства в порядке проверки, и порядок здесь несущий: Edge,
// Yandex, Opera и Samsung представляются Chrome'ом, а Chrome — Safari. Первое
// совпадение выигрывает, поэтому производные идут раньше основы.
var browserMarkers = []struct {
	marker string
	name   string
}{
	{"edg/", "Edge"},
	{"edga/", "Edge"},
	{"edgios/", "Edge"},
	{"yabrowser", "Яндекс.Браузер"},
	{"opr/", "Opera"},
	{"opera", "Opera"},
	{"samsungbrowser", "Samsung Internet"},
	{"vivaldi", "Vivaldi"},
	{"firefox", "Firefox"},
	{"fxios", "Firefox"},
	{"chrome", "Chrome"},
	{"crios", "Chrome"},
	{"safari", "Safari"},
}

// osMarkers — то же правило порядка: «Android» встречается в строках, где есть и
// «Linux», а iPadOS представляется «Mac OS X» на iPad.
var osMarkers = []struct {
	marker string
	name   string
}{
	{"windows nt", "Windows"},
	{"android", "Android"},
	{"iphone", "iOS"},
	{"ipad", "iPadOS"},
	{"ipod", "iOS"},
	{"cros", "ChromeOS"},
	{"mac os x", "macOS"},
	{"macintosh", "macOS"},
	{"ubuntu", "Ubuntu"},
	{"linux", "Linux"},
}

// ParseUserAgent разбирает строку. Пустая строка (бикон без заголовка) даёт
// пустой результат с DeviceDesktop — нет, поэтому вид тоже пуст: догадка о виде
// устройства по отсутствию данных была бы враньём в пропорциях.
func ParseUserAgent(raw string) UserAgent {
	ua := strings.ToLower(raw)
	if strings.TrimSpace(ua) == "" {
		return UserAgent{}
	}

	for _, m := range botMarkers {
		if strings.Contains(ua, m) {
			return UserAgent{Browser: "Робот", OS: "", Device: DeviceBot}
		}
	}

	out := UserAgent{Device: deviceKind(ua)}
	for _, b := range browserMarkers {
		if strings.Contains(ua, b.marker) {
			out.Browser = b.name
			break
		}
	}
	for _, o := range osMarkers {
		if strings.Contains(ua, o.marker) {
			out.OS = o.name
			break
		}
	}
	return out
}

// deviceKind различает три вида по маркерам самих производителей. «Android» без
// «mobi» — планшет: это правило самой Google для своих устройств, и другого
// признака в строке нет.
func deviceKind(ua string) DeviceKind {
	switch {
	case strings.Contains(ua, "ipad"), strings.Contains(ua, "tablet"):
		return DeviceTablet
	case strings.Contains(ua, "android"):
		if strings.Contains(ua, "mobi") {
			return DeviceMobile
		}
		return DeviceTablet
	case strings.Contains(ua, "iphone"), strings.Contains(ua, "ipod"),
		strings.Contains(ua, "mobi"), strings.Contains(ua, "windows phone"):
		return DeviceMobile
	default:
		return DeviceDesktop
	}
}

// DeviceLabel — подпись вида устройства для экрана. Не в TypeScript: подпись и
// значение обязаны меняться вместе, а ветка по строке на фронте — вторая копия
// правила, которая при новом виде молча покажет пустую строку.
func DeviceLabel(d DeviceKind) string {
	switch d {
	case DeviceDesktop:
		return "Компьютер"
	case DeviceMobile:
		return "Телефон"
	case DeviceTablet:
		return "Планшет"
	case DeviceBot:
		return "Роботы"
	default:
		return "Не определено"
	}
}
