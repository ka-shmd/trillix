package notify

import "testing"

// Реестр — единственное место, где повод описан, и молчание реестра должно
// краснеть здесь, а не оборачиваться уведомлением без текста в шторке (тот же
// приём, что у workspaces.AllActions и каталога тарифов).
func TestRegistry_CoversAllKinds(t *testing.T) {
	if len(registry) != len(AllKinds) {
		t.Fatalf("в реестре %d поводов, в AllKinds %d — списки разъехались", len(registry), len(AllKinds))
	}
	for _, k := range AllKinds {
		sp, ok := registry[k]
		if !ok {
			t.Fatalf("повод %q объявлен, но реестр про него молчит", k)
		}
		if sp.action == "" {
			t.Errorf("повод %q не называет действия — адресата у него нет", k)
		}
		if sp.text == nil || sp.link == nil {
			t.Errorf("повод %q без текста или без ссылки", k)
		}
	}
}

// Препятствия названы поимённо: у них есть парная точка отбоя, и добавление
// нового повода-препятствия обязано быть решением, а не опечаткой в структуре.
func TestRegistry_Obstacles(t *testing.T) {
	want := map[Kind]bool{
		KindNewSubmissions:    false,
		KindIntegrationBroken: true,
		KindOverQuota:         true,
	}
	for k, obstacle := range want {
		if registry[k].obstacle != obstacle {
			t.Errorf("повод %q: препятствие=%v, ожидалось %v", k, registry[k].obstacle, obstacle)
		}
	}
}

func TestKindText(t *testing.T) {
	cases := []struct {
		name  string
		kind  Kind
		p     Payload
		count int32
		want  string
	}{
		{
			name: "один ответ", kind: KindNewSubmissions,
			p: Payload{FormTitle: "Заявка"}, count: 1,
			want: "Заявка — 1 новый ответ",
		},
		{
			name: "три ответа", kind: KindNewSubmissions,
			p: Payload{FormTitle: "Заявка"}, count: 3,
			want: "Заявка — 3 новых ответа",
		},
		{
			name: "двенадцать ответов", kind: KindNewSubmissions,
			p: Payload{FormTitle: "Заявка"}, count: 12,
			want: "Заявка — 12 новых ответов",
		},
		{
			// Форма без названия называется тем же словом, что в списке форм:
			// строка «— 3 новых ответа» без подлежащего читается как поломка.
			name: "форма без названия", kind: KindNewSubmissions,
			p: Payload{FormTitle: "  "}, count: 3,
			want: "Без названия — 3 новых ответа",
		},
		{
			name: "поломка вебхука", kind: KindIntegrationBroken,
			p: Payload{
				FormTitle: "Заявка", Target: "webhook", TargetName: "CRM",
				Reason: "Получатель не отвечает (500).",
			},
			count: 1,
			want:  "Заявка — CRM: Получатель не отвечает (500).",
		},
		{
			// Имя цели автор давать не обязан — тогда цель называется своим видом.
			name: "поломка безымянной связки", kind: KindIntegrationBroken,
			p:     Payload{FormTitle: "Заявка", Target: "sheet", Reason: "Доступ к таблице потерян."},
			count: 1,
			want:  "Заявка — таблица: Доступ к таблице потерян.",
		},
		{
			name: "сверхлимитные ответы", kind: KindOverQuota,
			p: Payload{Period: "2026-09"}, count: 7,
			want: "Ответы сверх лимита тарифа: 7",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := registry[c.kind].text(c.p, c.count); got != c.want {
				t.Errorf("текст = %q, ожидался %q", got, c.want)
			}
		})
	}
}

// Ссылка ведёт туда, где повод можно закрыть делом: к ответам, к интеграциям
// формы, к тарифу пространства.
func TestKindLink(t *testing.T) {
	cases := []struct {
		kind Kind
		p    Payload
		slug string
		want string
	}{
		{KindNewSubmissions, Payload{FormSlug: "zayavka"}, "team", "/forms/zayavka/responses"},
		{KindIntegrationBroken, Payload{FormSlug: "zayavka"}, "team", "/forms/zayavka/integrations"},
		{KindOverQuota, Payload{}, "team", "/w/team/plan"},
	}
	for _, c := range cases {
		if got := registry[c.kind].link(c.p, c.slug); got != c.want {
			t.Errorf("%s: ссылка = %q, ожидалась %q", c.kind, got, c.want)
		}
	}
}
