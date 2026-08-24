package main

import (
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/migrations"
)

func TestDataLoss(t *testing.T) {
	cases := []struct {
		name string
		sql  string
		want []string
	}{
		{"удаление таблицы", "DROP TABLE IF EXISTS outbox;", []string{"DROP TABLE"}},
		{"удаление колонки", "ALTER TABLE outbox DROP COLUMN coalesce_key;", []string{"DROP COLUMN"}},
		{"чистка строк", "DELETE FROM plans WHERE code = 'pro';", []string{"DELETE FROM"}},
		{"снятие индекса данных не уносит", "DROP INDEX idx_outbox_coalesce;", nil},
		{"смена типа данных не уносит", "ALTER TABLE forms ALTER COLUMN title TYPE TEXT;", nil},
		{
			// Комментарий — объяснение, а не действие: вопрос по его поводу
			// научил бы отвечать yes не читая.
			name: "упоминание в комментарии не считается",
			sql:  "-- Порядок обратный созданию, иначе DROP TABLE упрётся в FK.\nDROP INDEX idx_a;",
			want: nil,
		},
		{"перенос строки внутри операции", "DROP\n   TABLE forms;", []string{"DROP TABLE"}},
		{"несколько операций", "TRUNCATE visits;\nDROP TABLE forms;", []string{"DROP TABLE", "TRUNCATE"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := dataLoss(c.sql)
			if strings.Join(got, ",") != strings.Join(c.want, ",") {
				t.Errorf("dataLoss(%q) = %v, ожидалось %v", c.sql, got, c.want)
			}
		})
	}
}

// Откат 0029 — тот самый, что молча унёс подключённые аккаунты Google. Тест
// смотрит на настоящий файл, а не на его копию в строке: разъедься они, копия
// осталась бы зелёной.
func TestDataLossRealDownMigration(t *testing.T) {
	sql, err := migrations.FS.ReadFile("0029_integrations.down.sql")
	if err != nil {
		t.Fatalf("прочитать откат 0029: %v", err)
	}
	if got := dataLoss(string(sql)); len(got) == 0 {
		t.Error("откат 0029 удаляет таблицы интеграций, но потерей данных не считается")
	}
}

func TestConfirmDown(t *testing.T) {
	destructive := postgres.DownMigration{Version: 29, Name: "integrations", SQL: "DROP TABLE form_integrations;"}
	harmless := postgres.DownMigration{Version: 13, Name: "notify", SQL: "DROP INDEX idx_outbox_coalesce;"}

	// Тест не сидит на терминале, значит спросить некого: подтверждения нет.
	if err := confirmDown(false)(destructive); err == nil {
		t.Error("откат с потерей данных без --force и без человека обязан отменяться")
	}
	if err := confirmDown(true)(destructive); err != nil {
		t.Errorf("--force обязан пропускать откат: %v", err)
	}
	if err := confirmDown(false)(harmless); err != nil {
		t.Errorf("откат без потери данных вопросов не задаёт: %v", err)
	}
}
