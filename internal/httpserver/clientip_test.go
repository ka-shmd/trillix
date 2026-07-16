package httpserver

import (
	"net/http"
	"testing"
)

func TestClientIP(t *testing.T) {
	tests := []struct {
		name         string
		remoteAddr   string
		xff          string
		trustedProxy bool
		want         string
	}{
		{
			name:       "direct: host from RemoteAddr",
			remoteAddr: "203.0.113.7:54321",
			want:       "203.0.113.7",
		},
		{
			name:       "direct: XFF ignored when untrusted",
			remoteAddr: "203.0.113.7:54321",
			xff:        "198.51.100.9",
			want:       "203.0.113.7",
		},
		{
			name:       "direct: RemoteAddr without port falls back to raw",
			remoteAddr: "203.0.113.7",
			want:       "203.0.113.7",
		},
		{
			name:         "trusted: single XFF entry",
			remoteAddr:   "10.0.0.1:9000", // адрес прокси
			xff:          "198.51.100.9",
			trustedProxy: true,
			want:         "198.51.100.9",
		},
		{
			name:         "trusted: takes rightmost (last-hop) of chain",
			remoteAddr:   "10.0.0.1:9000",
			xff:          "1.2.3.4, 5.6.7.8, 198.51.100.9",
			trustedProxy: true,
			want:         "198.51.100.9",
		},
		{
			name:         "trusted: trims whitespace",
			remoteAddr:   "10.0.0.1:9000",
			xff:          "198.51.100.9 ",
			trustedProxy: true,
			want:         "198.51.100.9",
		},
		{
			name:         "trusted: no XFF falls back to RemoteAddr",
			remoteAddr:   "10.0.0.1:9000",
			trustedProxy: true,
			want:         "10.0.0.1",
		},
		{
			name:         "trusted: empty XFF value falls back to RemoteAddr",
			remoteAddr:   "10.0.0.1:9000",
			xff:          "  ",
			trustedProxy: true,
			want:         "10.0.0.1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := &http.Request{RemoteAddr: tt.remoteAddr, Header: http.Header{}}
			if tt.xff != "" {
				r.Header.Set("X-Forwarded-For", tt.xff)
			}
			if got := ClientIP(r, tt.trustedProxy); got != tt.want {
				t.Errorf("ClientIP() = %q, want %q", got, tt.want)
			}
		})
	}
}
