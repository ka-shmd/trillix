// Package migrations встраивает .sql-файлы миграций в бинарник, чтобы раннер
// `api migrate up` был самодостаточен (в проде — та же init-команда без копирования файлов).
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
