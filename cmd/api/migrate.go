package main

import (
	"bufio"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/ka-shmd/trillix/internal/config"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Откат миграции — единственная команда продукта, которая уничтожает данные по
// одному слову в терминале, и уничтожает молча: `migrate down` печатал результат
// уже после того, как таблицы удалены. Цена ошибки не равна цене отката схемы:
// вместе с таблицами уезжает то, что повторный `up` не вернёт, — подключённые
// аккаунты Google, за которыми стоит согласие живого человека.
// История — JOURNAL, «Откат миграции стал громким».

// dataLossKeywords — операции, после которых повторный `up` данные не вернёт.
// Список намеренно короткий: он ловит потерю СТРОК, а не изменение схемы. Снятый
// индекс, удалённый тип или constraint возвращаются накатом обратно, поэтому
// вопросов о них не задаётся — иначе подтверждение станет ритуалом, который жмут
// не читая.
var dataLossKeywords = []string{"DROP TABLE", "DROP COLUMN", "DROP SCHEMA", "TRUNCATE", "DELETE FROM"}

func runMigrate(args []string, cfg config.Config, log *slog.Logger) error {
	if len(args) == 0 {
		return errors.New("usage: api migrate up|down [--force]")
	}
	force := false
	for _, arg := range args[1:] {
		if arg != "--force" {
			return fmt.Errorf("unknown flag %q (usage: api migrate up|down [--force])", arg)
		}
		force = true
	}

	switch args[0] {
	case "up":
		if force {
			return errors.New("--force относится только к откату: api migrate down --force")
		}
		if err := postgres.MigrateUp(cfg.DatabaseURL); err != nil {
			return err
		}
		log.Info("migrations applied")
		return nil
	case "down":
		down, err := postgres.MigrateDown(cfg.DatabaseURL, confirmDown(force))
		if err != nil {
			return err
		}
		if !down.Applied() {
			log.Info("nothing to revert: database has no migrations applied")
			return nil
		}
		log.Info("migration reverted",
			slog.Uint64("version", uint64(down.Version)),
			slog.String("name", down.Name))
		return nil
	default:
		return fmt.Errorf("unknown migrate direction %q (up|down)", args[0])
	}
}

// confirmDown — ворота отката: называют миграцию до того, как её исполнят, и
// требуют подтверждения, если она уносит данные.
//
// Диалог идёт в stderr мимо slog: это разговор с человеком, а не запись о
// событии, и в конвейере (`| grep`) он обязан остаться на экране.
func confirmDown(force bool) func(postgres.DownMigration) error {
	return func(down postgres.DownMigration) error {
		fmt.Fprintf(os.Stderr, "Откатываю миграцию %d (%s).\n", down.Version, down.Name)

		loss := dataLoss(down.SQL)
		if len(loss) == 0 || force {
			return nil
		}
		fmt.Fprintf(os.Stderr,
			"Она уносит данные (%s). Повторный `up` вернёт пустые таблицы, а не содержимое.\n",
			strings.Join(loss, ", "))

		fmt.Fprint(os.Stderr, "Продолжить? Введите yes (в неинтерактивном запуске — флаг --force): ")
		answer, err := bufio.NewReader(os.Stdin).ReadString('\n')
		// Пустой ответ с ошибкой чтения — не сбой, а отсутствие человека:
		// контейнер и CI получают stdin из /dev/null, и отличить его от
		// терминала без новой зависимости нельзя (x/term в списке нет). Молчание
		// трактуется как «нет» и подсказывает флаг.
		if strings.TrimSpace(answer) != "yes" {
			if err != nil {
				return errors.New("откат отменён: подтверждения нет — в неинтерактивном запуске нужен флаг --force")
			}
			return errors.New("откат отменён")
		}
		return nil
	}
}

// dataLoss — какие необратимые операции есть в тексте отката.
//
// Комментарии вырезаются, пробелы схлопываются: в down-файлах этого проекта
// «DROP TABLE» встречается и в объяснении, почему порядок удаления такой, а
// вопрос по поводу комментария научил бы жать yes не читая.
func dataLoss(sql string) []string {
	text := strings.ToUpper(strings.Join(strings.Fields(stripLineComments(sql)), " "))
	var found []string
	for _, kw := range dataLossKeywords {
		if strings.Contains(text, kw) {
			found = append(found, kw)
		}
	}
	return found
}

func stripLineComments(sql string) string {
	lines := strings.Split(sql, "\n")
	for i, line := range lines {
		if at := strings.Index(line, "--"); at >= 0 {
			lines[i] = line[:at]
		}
	}
	return strings.Join(lines, "\n")
}
