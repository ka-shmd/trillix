package httpserver

import "testing"

func TestHostCookie(t *testing.T) {
	tests := []struct {
		name   string
		secure bool
		want   string
	}{
		{name: "session", secure: true, want: "__Host-session"},
		{name: "csrf_token", secure: true, want: "__Host-csrf_token"},
		// Без Secure браузер отверг бы префиксную cookie целиком — dev по http
		// остался бы без входа.
		{name: "session", secure: false, want: "session"},
	}
	for _, tt := range tests {
		if got := HostCookie(tt.name, tt.secure); got != tt.want {
			t.Errorf("HostCookie(%q, %v) = %q, want %q", tt.name, tt.secure, got, tt.want)
		}
	}
}
