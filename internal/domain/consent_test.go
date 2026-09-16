package domain

import (
	"errors"
	"strings"
	"testing"
)

func sampleConsent() ConsentSettings {
	return NormalizeConsentSettings(ConsentSettings{
		Operator: ConsentOperator{Name: "ООО «Ромашка»", INN: "7700000000", Address: "Москва, ул. Лесная, 1", Email: "pd@romashka.ru"},
	})
}

func TestValidateConsentSettings(t *testing.T) {
	valid := sampleConsent()
	if err := ValidateConsentSettings(true, valid); err != nil {
		t.Fatalf("заполненный раздел отвергнут: %v", err)
	}

	custom := NormalizeConsentSettings(ConsentSettings{
		Consent: ConsentDoc{Mode: ConsentDocCustom, Text: "Мой текст согласия"},
		Policy:  ConsentDoc{Mode: ConsentDocCustom, Text: "Моя политика"},
	})
	if err := ValidateConsentSettings(true, custom); err != nil {
		t.Fatalf("два своих текста без реквизитов — законно, свой текст несёт их сам: %v", err)
	}

	// Выключенный раздел законно недозаполнен: автор выключил согласие посреди ввода.
	if err := ValidateConsentSettings(false, NormalizeConsentSettings(ConsentSettings{})); err != nil {
		t.Fatalf("пустой выключенный раздел отвергнут: %v", err)
	}

	cases := map[string]struct {
		enabled bool
		mutate  func(*ConsentSettings)
	}{
		"нет наименования при типовом": {true, func(s *ConsentSettings) { s.Operator.Name = "" }},
		"нет адреса при типовом":       {true, func(s *ConsentSettings) { s.Operator.Address = "" }},
		"нет email при типовом":        {true, func(s *ConsentSettings) { s.Operator.Email = "" }},
		"одна политика типовая": {true, func(s *ConsentSettings) {
			s.Operator.Name = ""
			s.Consent = ConsentDoc{Mode: ConsentDocCustom, Text: "x"}
		}},
		"пустой свой текст":            {true, func(s *ConsentSettings) { s.Consent = ConsentDoc{Mode: ConsentDocCustom, Text: "  \n "} }},
		"чужой источник текста":        {true, func(s *ConsentSettings) { s.Policy.Mode = "link" }},
		"ИНН из девяти цифр":           {false, func(s *ConsentSettings) { s.Operator.INN = "123456789" }},
		"ИНН с буквой":                 {false, func(s *ConsentSettings) { s.Operator.INN = "77000000O0" }},
		"email с именем":               {false, func(s *ConsentSettings) { s.Operator.Email = "Ромашка <pd@romashka.ru>" }},
		"текст длиннее потолка":        {false, func(s *ConsentSettings) { s.Policy.Text = strings.Repeat("я", MaxConsentDocTextLen+1) }},
		"цель длиннее потолка в рунах": {false, func(s *ConsentSettings) { s.Purpose = strings.Repeat("ц", MaxConsentPurposeLen+1) }},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			s := sampleConsent()
			c.mutate(&s)
			if err := ValidateConsentSettings(c.enabled, s); !errors.Is(err, ErrValidation) {
				t.Fatalf("err = %v, ожидалась ErrValidation", err)
			}
		})
	}
}

func TestRenderConsentDocument_Template(t *testing.T) {
	s := sampleConsent()
	in := ConsentDocInput{FormTitle: "Запись на приём", DataItems: []string{"Имя", "Телефон", " "}}

	doc, err := RenderConsentDocument(ConsentDocConsent, s, ConsentTemplateVersion, in)
	if err != nil {
		t.Fatalf("RenderConsentDocument: %v", err)
	}
	if doc.Title != "Согласие на обработку персональных данных" {
		t.Errorf("заголовок = %q", doc.Title)
	}
	// Всё, без чего согласие не «информированное» (спека §2): оператор с ИНН и адресом,
	// цель, перечень данных из вопросов, срок, порядок отзыва с адресом.
	for _, want := range []string{
		"ООО «Ромашка», ИНН 7700000000, адрес: Москва, ул. Лесная, 1",
		"форму «Запись на приём»",
		"Цель обработки: " + DefaultConsentPurpose,
		"«Имя»; «Телефон».",
		"Срок обработки: " + DefaultConsentRetention,
		"по адресу электронной почты pd@romashka.ru",
		"152-ФЗ",
	} {
		if !strings.Contains(doc.Text, want) {
			t.Errorf("в согласии нет %q:\n%s", want, doc.Text)
		}
	}

	s.Purpose, s.Retention, s.Operator.INN = "запись на приём к врачу", "один год", ""
	policy, err := RenderConsentDocument(ConsentDocPolicy, s, ConsentTemplateVersion, ConsentDocInput{})
	if err != nil {
		t.Fatalf("RenderConsentDocument(policy): %v", err)
	}
	for _, want := range []string{
		"ООО «Ромашка», адрес: Москва",
		"Цель обработки: запись на приём к врачу.",
		"Срок обработки: один год.",
		"Обрабатываются сведения, указанные в Форме.",
		"статьи 18.1",
		"pd@romashka.ru",
	} {
		if !strings.Contains(policy.Text, want) {
			t.Errorf("в политике нет %q:\n%s", want, policy.Text)
		}
	}
	if strings.Contains(policy.Text, "ИНН") {
		t.Error("пустой ИНН попал в текст")
	}
}

func TestRenderConsentDocument_CustomAndUnknown(t *testing.T) {
	s := sampleConsent()
	s.Policy = ConsentDoc{Mode: ConsentDocCustom, Text: "Своя политика\n\nвторой абзац"}
	doc, err := RenderConsentDocument(ConsentDocPolicy, s, ConsentTemplateVersion, ConsentDocInput{})
	if err != nil || doc.Text != "Своя политика\n\nвторой абзац" {
		t.Fatalf("свой текст = %q, %v — ожидался как есть", doc.Text, err)
	}
	// Версия шаблона, которой нет, — отказ, а не молчаливая подмена текущим текстом:
	// иначе страница документа показала бы не то, с чем соглашались.
	if _, err := RenderConsentDocument(ConsentDocConsent, s, ConsentTemplateVersion+1, ConsentDocInput{}); err == nil {
		t.Fatal("неизвестная версия шаблона собрала документ")
	}
	if _, err := RenderConsentDocument("offer", s, ConsentTemplateVersion, ConsentDocInput{}); !errors.Is(err, ErrValidation) {
		t.Fatalf("неизвестный документ: err = %v", err)
	}
}
