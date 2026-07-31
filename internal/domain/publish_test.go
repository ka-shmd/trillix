package domain

import "testing"

// Гейт публикации (фаза 16, этап 16.5). Проверяется главное свойство: гейт строже
// ValidateSchema ровно там, где обещал, и НЕ строже нигде больше — документ, который
// автосейв обязан хранить, остаётся валидным, просто не публикуется.

func kinds(bs PublishBlockers) []PublishBlockerKind {
	out := make([]PublishBlockerKind, len(bs))
	for i, b := range bs {
		out[i] = b.Kind
	}
	return out
}

func schema(blocks ...Block) FormSchema {
	return FormSchema{SchemaVersion: SchemaVersion, Blocks: blocks}
}

func TestPublishGate_Passes(t *testing.T) {
	cases := map[string]FormSchema{
		// Форма без единого вопроса — законный документ (страница с одним текстом).
		"пустая форма": schema(),
		"только текст": schema(Block{ID: "p", GroupID: "g1", Type: BlockText, Text: TextFromString("Привет")}),
		"вопрос с заголовком": schema(
			Block{ID: "t", GroupID: "g1", Type: BlockTitle, Text: TextFromString("Ваше имя")},
			Block{ID: "b", GroupID: "g1", Type: BlockShortText},
		),
		// Три способа назвать вопрос помимо заголовка — все засчитываются, потому что
		// гейт стоит на той же цепочке, что и подпись в выгрузке.
		"голое поле с плейсхолдером": schema(
			Block{ID: "b", GroupID: "g1", Type: BlockEmail, Settings: BlockSettings{Placeholder: "you@example.com"}},
		),
		"голое поле с именем": schema(
			Block{ID: "b", GroupID: "g1", Type: BlockScale, Name: "nps"},
		),
		"согласие со своим текстом": schema(
			Block{ID: "c", GroupID: "g1", Type: BlockConsent, Text: TextFromString("Соглашаюсь")},
		),
		"choice с одним вариантом": schema(
			Block{ID: "t", GroupID: "g1", Type: BlockTitle, Text: TextFromString("Откуда узнали?")},
			Block{ID: "b", GroupID: "g1", Type: BlockSingleChoice, Settings: BlockSettings{
				Options: []Option{{ID: "o1", Label: "Друзья"}},
			}},
		),
		// Заголовок ФОРМЫ — не подпись вопроса: пустой он законен и на публикацию не
		// влияет (форма без названия существует с фазы 15).
		"пустой заголовок формы": schema(
			Block{ID: "ft", GroupID: "gft", Type: BlockFormTitle},
			Block{ID: "b", GroupID: "g1", Type: BlockShortText, Name: "q"},
		),
	}

	for name, s := range cases {
		t.Run(name, func(t *testing.T) {
			if got := PublishGate(s); len(got) > 0 {
				t.Fatalf("гейт не пропустил: %v", kinds(got))
			}
		})
	}
}

func TestPublishGate_Blocks(t *testing.T) {
	cases := map[string]struct {
		schema FormSchema
		want   []PublishBlockerKind
	}{
		"вопрос без имени вовсе": {
			schema: schema(Block{ID: "b", GroupID: "g1", Type: BlockScale}),
			want:   []PublishBlockerKind{BlockerUnnamedQuestion},
		},
		"заголовок из одних пробелов не считается": {
			schema: schema(
				Block{ID: "t", GroupID: "g1", Type: BlockTitle, Text: TextFromString("   ")},
				Block{ID: "b", GroupID: "g1", Type: BlockShortText},
			),
			// Два замечания об одном вопросе, и оба верны: подпись пуста, вопрос безымянен.
			want: []PublishBlockerKind{BlockerEmptyCaption, BlockerUnnamedQuestion},
		},
		"пустая подпись при названном поле": {
			schema: schema(
				Block{ID: "t", GroupID: "g1", Type: BlockTitle},
				Block{ID: "b", GroupID: "g1", Type: BlockShortText, Name: "fio"},
			),
			want: []PublishBlockerKind{BlockerEmptyCaption},
		},
		"choice без вариантов": {
			schema: schema(
				Block{ID: "t", GroupID: "g1", Type: BlockTitle, Text: TextFromString("Город")},
				Block{ID: "b", GroupID: "g1", Type: BlockDropdown},
			),
			want: []PublishBlockerKind{BlockerChoiceWithoutOptions},
		},
		// Один блок нарушает два правила — обязан дать ДВА замечания: «почините одно,
		// узнаете про второе» это ровно то, чего список и избегает.
		"голый список выбора без заголовка": {
			schema: schema(Block{ID: "b", GroupID: "g1", Type: BlockMultiChoice}),
			want:   []PublishBlockerKind{BlockerUnnamedQuestion, BlockerChoiceWithoutOptions},
		},
		"порядок блокеров — порядок документа": {
			schema: schema(
				Block{ID: "b1", GroupID: "g1", Type: BlockScale},
				Block{ID: "l", GroupID: "g2", Type: BlockLabel},
				Block{ID: "b2", GroupID: "g2", Type: BlockSingleChoice, Name: "q"},
			),
			want: []PublishBlockerKind{
				BlockerUnnamedQuestion, BlockerEmptyCaption, BlockerChoiceWithoutOptions,
			},
		},
	}

	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			got := PublishGate(c.schema)
			gk := kinds(got)
			if len(gk) != len(c.want) {
				t.Fatalf("блокеры = %v, ждали %v", gk, c.want)
			}
			for i := range c.want {
				if gk[i] != c.want[i] {
					t.Fatalf("блокер #%d = %q, ждали %q (весь список: %v)", i, gk[i], c.want[i], gk)
				}
			}
			// Каждый блокер обязан указывать на блок: по этому id кабинет переводит
			// каретку на строку. Блокер без адреса бесполезен.
			for _, b := range got {
				if b.BlockID == "" || b.Message == "" {
					t.Fatalf("блокер без адреса или без сообщения: %+v", b)
				}
			}
		})
	}
}

// Граница гейта и валидатора: документ, который гейт отвергает, ValidateSchema обязан
// принимать. Иначе автосейв ловил бы 422 посреди сборки формы — то самое, ради чего
// правило вынесено в момент публикации, а не хранения.
func TestPublishGate_BlockedDocumentsStayValid(t *testing.T) {
	docs := []string{
		`{"schemaVersion":4,"blocks":[{"id":"b","groupId":"g1","type":"scale","settings":{}}]}`,
		`{"schemaVersion":4,"blocks":[{"id":"t","groupId":"g1","type":"title"},{"id":"b","groupId":"g1","type":"short_text","settings":{}}]}`,
		`{"schemaVersion":4,"blocks":[{"id":"b","groupId":"g1","type":"multi_choice","settings":{}}]}`,
	}
	for _, raw := range docs {
		parsed, err := ValidateSchema([]byte(raw))
		if err != nil {
			t.Fatalf("валидатор отверг черновик, который обязан хранить: %v (%s)", err, raw)
		}
		if got := PublishGate(parsed); len(got) == 0 {
			t.Fatalf("гейт пропустил документ, который должен блокировать: %s", raw)
		}
	}
}
