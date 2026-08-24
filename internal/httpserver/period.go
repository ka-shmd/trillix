package httpserver

import (
	"net/http"

	"github.com/ka-shmd/trillix/internal/domain"
)

// PeriodFromRequest — окно наблюдения аналитического экрана из query-строки
// (`?from=…&to=…`, RFC 3339). Отсутствие обоих параметров — «всё время».
//
// Здесь, а не в каждом handler'е: параметры читают четыре ручки аналитики, и
// разъехавшиеся имена (`from` против `since`) обнаружились бы не падением, а
// молча игнорируемым периодом на одном из экранов.
func PeriodFromRequest(r *http.Request) (domain.Period, error) {
	q := r.URL.Query()
	return domain.ParsePeriod(q.Get("from"), q.Get("to"))
}
