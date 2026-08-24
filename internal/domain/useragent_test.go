package domain

import "testing"

func TestParseUserAgent(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		ua   string
		want UserAgent
	}{
		{
			name: "Chrome на Windows",
			ua:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
			want: UserAgent{Browser: "Chrome", OS: "Windows", Device: DeviceDesktop},
		},
		{
			// Ловушка порядка: Edge представляется и Chrome'ом, и Safari.
			name: "Edge не Chrome",
			ua:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
			want: UserAgent{Browser: "Edge", OS: "Windows", Device: DeviceDesktop},
		},
		{
			name: "Яндекс.Браузер не Chrome",
			ua:   "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/136.0.0.0 YaBrowser/25.6.0.0 Safari/537.36",
			want: UserAgent{Browser: "Яндекс.Браузер", OS: "Windows", Device: DeviceDesktop},
		},
		{
			// Ловушка основы: Safari не должен ловиться у всех, кто его упоминает.
			name: "настоящий Safari на macOS",
			ua:   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
			want: UserAgent{Browser: "Safari", OS: "macOS", Device: DeviceDesktop},
		},
		{
			name: "Safari на iPhone — телефон",
			ua:   "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
			want: UserAgent{Browser: "Safari", OS: "iOS", Device: DeviceMobile},
		},
		{
			// iPad представляется «Mac OS X», отличается только словом ipad.
			name: "iPad — планшет, а не macOS",
			ua:   "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1",
			want: UserAgent{Browser: "Safari", OS: "iPadOS", Device: DeviceTablet},
		},
		{
			name: "Chrome на телефоне Android",
			ua:   "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
			want: UserAgent{Browser: "Chrome", OS: "Android", Device: DeviceMobile},
		},
		{
			// Android без «Mobi» — планшет: правило самой Google, другого признака нет.
			name: "Android без Mobi — планшет",
			ua:   "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
			want: UserAgent{Browser: "Chrome", OS: "Android", Device: DeviceTablet},
		},
		{
			name: "Firefox на Ubuntu",
			ua:   "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
			want: UserAgent{Browser: "Firefox", OS: "Ubuntu", Device: DeviceDesktop},
		},
		{
			// Робот проверяется ПЕРВЫМ: он представляется поверх обычной строки
			// браузера, и без этого порядка Googlebot стал бы Safari на десктопе.
			name: "Googlebot — робот, а не Safari",
			ua:   "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) Safari/537.36",
			want: UserAgent{Browser: "Робот", Device: DeviceBot},
		},
		{
			name: "curl — тоже робот",
			ua:   "curl/8.5.0",
			want: UserAgent{Browser: "Робот", Device: DeviceBot},
		},
		{
			// Пустой заголовок не даёт догадки о виде устройства: приписать такой
			// визит десктопу значило бы соврать в пропорциях, ради которых экран и
			// существует.
			name: "пустая строка — ничего не опознали",
			ua:   "",
			want: UserAgent{},
		},
		{
			name: "неизвестный агент — вид есть, имён нет",
			ua:   "SomeUnknownClient/1.0",
			want: UserAgent{Device: DeviceDesktop},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := ParseUserAgent(tt.ua); got != tt.want {
				t.Errorf("разбор = %+v, ждали %+v", got, tt.want)
			}
		})
	}
}
