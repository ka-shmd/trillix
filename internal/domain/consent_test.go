package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

func sampleConsent() ConsentSettings {
	return NormalizeConsentSettings(ConsentSettings{
		Operator: ConsentOperator{Name: "ООО «Ромашка»", INN: "7700000000", Address: "Москва, ул. Лесная, 1", Email: "pd@romashka.ru"},
	})
}

func sampleConsentWith(mutate func(*ConsentSettings)) ConsentSettings {
	s := sampleConsent()
	mutate(&s)
	return s
}

func TestValidateConsentSettings(t *testing.T) {
	valid := sampleConsent()
	if err := ValidateConsentSettings(true, valid); err != nil {
		t.Fatalf("заполненный раздел отвергнут: %v", err)
	}

	custom := NormalizeConsentSettings(ConsentSettings{
		Documents: ConsentDocCustom, ConsentText: "Мой текст согласия", PolicyText: "Моя политика",
	})
	if err := ValidateConsentSettings(true, custom); err != nil {
		t.Fatalf("свои документы без реквизитов — законно, свой текст несёт их сам: %v", err)
	}
	// Поля скрытого режима автор не видит и исправить не может — они сохранение не держат.
	custom.Operator = ConsentOperator{INN: "123", Email: "не почта"}
	if err := ValidateConsentSettings(true, custom); err != nil {
		t.Fatalf("неверные реквизиты при своих документах отвергнуты: %v", err)
	}
	if err := ValidateConsentSettings(true, sampleConsentWith(func(s *ConsentSettings) { s.ConsentText = "" })); err != nil {
		t.Fatalf("пустой свой текст при типовых документах отвергнут: %v", err)
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
		"пустое своё согласие": {true, func(s *ConsentSettings) {
			s.Documents, s.ConsentText, s.PolicyText = ConsentDocCustom, "  \n ", "Политика"
		}},
		"пустая своя политика": {true, func(s *ConsentSettings) {
			s.Documents, s.ConsentText, s.PolicyText = ConsentDocCustom, "Согласие", ""
		}},
		"чужой источник документов": {false, func(s *ConsentSettings) { s.Documents = "link" }},
		"ИНН из девяти цифр":        {false, func(s *ConsentSettings) { s.Operator.INN = "123456789" }},
		"ИНН с буквой":              {false, func(s *ConsentSettings) { s.Operator.INN = "77000000O0" }},
		"email с именем":            {false, func(s *ConsentSettings) { s.Operator.Email = "Ромашка <pd@romashka.ru>" }},
		"текст длиннее потолка":     {false, func(s *ConsentSettings) { s.PolicyText = strings.Repeat("я", MaxConsentDocTextLen+1) }},
		// Потолок ИНН держит и свои документы, где формат не проверяется: ревизии не удаляются.
		"длинный ИНН при своих документах": {false, func(s *ConsentSettings) {
			s.Documents, s.ConsentText, s.PolicyText = ConsentDocCustom, "Согласие", "Политика"
			s.Operator.INN = strings.Repeat("1", MaxConsentOperatorINNLen+1)
		}},
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
	s.Documents, s.ConsentText, s.PolicyText = ConsentDocCustom, "Своё согласие", "Своя политика\n\nвторой абзац"
	doc, err := RenderConsentDocument(ConsentDocPolicy, s, ConsentTemplateVersion, ConsentDocInput{})
	if err != nil || doc.Text != "Своя политика\n\nвторой абзац" {
		t.Fatalf("свой текст = %q, %v — ожидался как есть", doc.Text, err)
	}
	// Версия шаблона, которой нет, — отказ, а не молчаливая подмена текущим текстом:
	// иначе страница документа показала бы не то, с чем соглашались.
	if _, err := RenderConsentDocument(ConsentDocConsent, sampleConsent(), ConsentTemplateVersion+1, ConsentDocInput{}); err == nil {
		t.Fatal("неизвестная версия шаблона собрала документ")
	}
	if _, err := RenderConsentDocument("offer", s, ConsentTemplateVersion, ConsentDocInput{}); !errors.Is(err, ErrValidation) {
		t.Fatalf("неизвестный документ: err = %v", err)
	}
}

// Отпечаток текста версии 1 шаблона. Страница документа восстанавливает по версии текст,
// с которым соглашался человек, поэтому формулировка версии на месте не правится — ни
// опечатка, ни пробел. Тест упал из-за правки текста — нужна новая версия шаблона
// (ConsentTemplateVersion + 1), а отпечаток версии 1 не меняется.
func TestConsentTemplateV1_Frozen(t *testing.T) {
	full := sampleConsentWith(func(s *ConsentSettings) {
		s.Purpose, s.Retention = "запись на приём", "один год"
	})
	bare := sampleConsentWith(func(s *ConsentSettings) { s.Operator.INN = "" })
	in := ConsentDocInput{FormTitle: "Запись", DataItems: []string{"Имя", "Телефон"}}
	want := map[string]string{
		"consent/full": "ccde8700f621ce186a5bc828dabdb4417b08e5d115a106c60cad8ca171b9e902",
		"policy/full":  "a193bf8cc051a9bfc64a7b8730c44741c487da540150880f3228d20d289e037a",
		"consent/bare": "86967dfb962a15898a25947b3fd78d7e68e8bac6e6f4cac82090d1e3bbd6c0db",
		"policy/bare":  "9d5949ca0b27d79eea9fa6b2672cb21a61e08e604c25ae8ad7b53757a544afde",
	}
	for _, c := range []struct {
		name string
		kind ConsentDocKind
		s    ConsentSettings
		in   ConsentDocInput
	}{
		{"consent/full", ConsentDocConsent, full, in},
		{"policy/full", ConsentDocPolicy, full, in},
		{"consent/bare", ConsentDocConsent, bare, ConsentDocInput{}},
		{"policy/bare", ConsentDocPolicy, bare, ConsentDocInput{}},
	} {
		doc, err := RenderConsentDocument(c.kind, c.s, 1, c.in)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		sum := sha256.Sum256([]byte(doc.Title + "\n" + doc.Text))
		if got := hex.EncodeToString(sum[:]); got != want[c.name] {
			t.Errorf("%s: текст версии 1 изменился (отпечаток %s)", c.name, got)
		}
	}
}
