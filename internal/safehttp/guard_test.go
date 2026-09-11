package safehttp

import (
	"net/netip"
	"testing"
)

func TestPublicOnly(t *testing.T) {
	cases := []struct {
		addr  string
		allow bool
	}{
		// Глобальные — пускаем.
		{"8.8.8.8", true},
		{"93.184.216.34", true},
		{"2606:4700::1111", true},
		{"2a00:1450:4001::1", true},
		{"::ffff:8.8.8.8", true},     // IPv4 в IPv6-обёртке решает вложенный адрес
		{"64:ff9b::808:808", true},   // NAT64 от 8.8.8.8
		{"172.15.255.255", true},     // соседи частной 172.16/12 по краям
		{"172.32.0.0", true},         //
		{"100.63.255.255", true},     // соседи CGNAT 100.64/10 по краям
		{"100.128.0.0", true},        //
		{"2001:200::1", true},        // сразу за протокольными 2001::/23
		{"3fff:1000::1", true},       // сразу за документационным 3fff::/20
		{"2003:de:2016::1", true},    // сразу за 6to4 2002::/16
		{"2001:4860:4860::88", true}, // вне 2001::/23, хотя тоже начинается с 2001

		// IPv4 внутренних и служебных сетей.
		{"127.0.0.1", false},
		{"127.255.255.254", false},
		{"0.0.0.0", false},
		{"10.1.2.3", false},
		{"172.16.0.1", false},
		{"172.31.255.255", false},
		{"192.168.1.1", false},
		{"169.254.169.254", false}, // метаданные облака
		{"100.64.0.1", false},
		{"192.0.0.9", false},
		{"192.0.2.1", false},
		{"198.18.0.1", false},
		{"198.51.100.7", false},
		{"203.0.113.7", false},
		{"224.0.0.1", false},
		{"255.255.255.255", false},

		// IPv6 вне глобального unicast и служебные внутри него.
		{"::1", false},
		{"::", false},
		{"fe80::1", false},
		{"fe80::1%eth0", false},
		{"fc00::1", false},
		{"fd12:3456::1", false},
		{"ff02::1", false},
		{"2001:db8::1", false},
		{"2001::1", false},        // Teredo
		{"2002:7f00:1::1", false}, // 6to4 от 127.0.0.1
		{"3fff::1", false},

		// Внутренний IPv4 в обёртке — всё тот же внутренний.
		{"::ffff:127.0.0.1", false},
		{"::ffff:10.0.0.1", false},
		{"::ffff:169.254.169.254", false},
		{"64:ff9b::7f00:1", false}, // NAT64 от 127.0.0.1
		{"64:ff9b::a00:1", false},  // NAT64 от 10.0.0.1
		{"64:ff9b:1::1", false},    // локальный NAT64 вне /96 — не глобальный unicast
	}
	for _, c := range cases {
		a := netip.MustParseAddr(c.addr)
		if got := (PublicOnly{}).Allowed(a); got != c.allow {
			t.Errorf("PublicOnly.Allowed(%s) = %v, ожидалось %v", c.addr, got, c.allow)
		}
	}
}

func TestPublicOnly_InvalidAddr(t *testing.T) {
	if (PublicOnly{}).Allowed(netip.Addr{}) {
		t.Fatal("нулевой адрес должен быть запрещён — отказ закрытым")
	}
}

func TestAllowAll(t *testing.T) {
	if !(AllowAll{}).Allowed(netip.MustParseAddr("127.0.0.1")) {
		t.Fatal("AllowAll пускает всё, в том числе loopback тестового сервера")
	}
}
