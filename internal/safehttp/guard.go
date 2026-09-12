package safehttp

import "net/netip"

// Guard решает, можно ли соединяться с адресом назначения.
type Guard interface {
	Allowed(netip.Addr) bool
}

// PublicOnly — боевой Guard: только глобально маршрутизируемые адреса.
type PublicOnly struct{}

func (PublicOnly) Allowed(a netip.Addr) bool { return isPublic(a) }

// AllowAll — пермиссивный Guard для тестов: httptest-сервер живёт на 127.0.0.1.
// В боевой сборке не встречается — как ratelimit.AllowAll.
type AllowAll struct{}

func (AllowAll) Allowed(netip.Addr) bool { return true }

// forbidden4 — IPv4, куда соединяться нельзя: реестр IANA special-purpose без
// глобально маршрутизируемых записей.
var forbidden4 = mustPrefixes(
	"0.0.0.0/8",       // «эта сеть»; соединение с 0.0.0.0 на Linux уходит на localhost
	"10.0.0.0/8",      // частная
	"100.64.0.0/10",   // CGNAT: у облаков это внутренняя сеть провайдера
	"127.0.0.0/8",     // loopback
	"169.254.0.0/16",  // link-local, в том числе метаданные облака 169.254.169.254
	"172.16.0.0/12",   // частная; сюда же попадают сети docker, где API стоит рядом с Postgres
	"192.0.0.0/24",    // протокольные назначения IETF
	"192.0.2.0/24",    // документация
	"192.88.99.0/24",  // ретранслятор 6to4, выведен из обращения
	"192.168.0.0/16",  // частная
	"198.18.0.0/15",   // стенды
	"198.51.100.0/24", // документация
	"203.0.113.0/24",  // документация
	"224.0.0.0/4",     // multicast
	"240.0.0.0/4",     // зарезервировано, включая широковещательный 255.255.255.255
)

// global6 — IPv6 разрешён только из глобального unicast. Всё вне его (loopback,
// unspecified, ULA fc00::/7, link-local, multicast) запрещено одним правилом, а
// не перечислением.
var global6 = netip.MustParsePrefix("2000::/3")

// forbidden6 — то, что внутри 2000::/3 глобальным интернетом не является или
// несёт IPv4 внутри адреса.
var forbidden6 = mustPrefixes(
	"2001::/23",     // протокольные назначения IETF, в том числе Teredo 2001::/32 (IPv4 внутри)
	"2001:db8::/32", // документация
	"2002::/16",     // 6to4: IPv4 внутри адреса
	"3fff::/20",     // документация
)

// nat64 — IPv4, завёрнутый шлюзом NAT64. Решает вложенный IPv4: запрет всего
// диапазона отрезал бы IPv4-хосты от сервера в IPv6-only сети.
var nat64 = netip.MustParsePrefix("64:ff9b::/96")

func isPublic(a netip.Addr) bool {
	// Адрес с зоной (fe80::1%eth0) — всегда локальный интерфейс.
	if !a.IsValid() || a.Zone() != "" {
		return false
	}
	// ::ffff:10.0.0.1 — тот же 10.0.0.1. Без Unmap он прошёл бы проверку как
	// IPv6, которого нет в списках.
	a = a.Unmap()
	if a.Is4() {
		return !containsAny(forbidden4, a)
	}
	if nat64.Contains(a) {
		b := a.As16()
		return isPublic(netip.AddrFrom4([4]byte(b[12:16])))
	}
	return global6.Contains(a) && !containsAny(forbidden6, a)
}

func containsAny(prefixes []netip.Prefix, a netip.Addr) bool {
	for _, p := range prefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func mustPrefixes(ss ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(ss))
	for i, s := range ss {
		out[i] = netip.MustParsePrefix(s)
	}
	return out
}
