package integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// API управления Яндекс Метрики (фаза 29 DEV-PLAN, спека docs/design/yandex-metrika.md
// §13.3–13.4): список счётчиков аккаунта и заведение целей продукта.
//
// Визитов и целей этот API не пишет — их пишет tag.js на странице формы по номеру
// счётчика (§6). Отсюда и роль: выбрать номер из списка вместо переписывания из
// чужой вкладки и завести три цели вместо трёх ручных форм, в которых опечатка
// в идентификаторе не засчитается никогда и сказать об этом некому.

// metrikaAPIURL — база ручек управления. Полем структуры, а не чтением константы:
// тесты подменяют её на httptest-сервер.
const metrikaAPIURL = "https://api-metrika.yandex.net/management/v1"

// metrikaGoalType — тип цели «JavaScript-событие». Отмечается вызовом
// ym(<номер>, 'reachGoal', '<идентификатор>') со страницы формы.
const metrikaGoalType = "action"

// metrikaCountersPerPage — потолок страницы списка счётчиков. Страница одна:
// выпадающий список выбора не рассчитан на большее, а аккаунт с тысячей
// счётчиков — агентство, которое номер и так знает наизусть.
const metrikaCountersPerPage = 1000

// MetrikaCounter — счётчик аккаунта в списке выбора.
type MetrikaCounter struct {
	ID   int64
	Name string
	// Site — сайт счётчика. Подпись в списке, а не адрес формы: у автора десяток
	// счётчиков с похожими названиями, и различает их именно домен.
	Site string
}

// MetrikaGoal — цель продукта: идентификатор JavaScript-события и имя, под
// которым цель видна в Метрике.
type MetrikaGoal struct {
	ID   string
	Name string
}

// GoalsResult — итог заведения целей: сколько завели и сколько уже было.
// Состояние целей нигде не хранится, оно живёт в Метрике (спека §13.4).
type GoalsResult struct {
	Created  int
	Existing int
}

// metrikaGoals — цели продукта. Идентификаторы зеркалят GOAL_* в
// web/renderer/src/features/form/metrika.ts: разойдутся — цель заведётся на
// идентификатор, которого страница формы не отмечает, и останется вечным нулём.
var metrikaGoals = []MetrikaGoal{
	{ID: "trillix_open", Name: "Trillix: форму открыли"},
	{ID: "trillix_start", Name: "Trillix: начали заполнять"},
	{ID: "trillix_submit", Name: "Trillix: отправили ответ"},
}

// ListCounters — счётчики аккаунта, цели которых он вправе заводить.
//
// Фильтр permission=own,edit не косметика: счётчик, куда аккаунт позвали
// наблюдателем, в списке означал бы отказ Яндекса уже ПОСЛЕ выбора — на шаге,
// где человек считает настройку законченной.
func (y *Yandex) ListCounters(ctx context.Context, accessToken string) ([]MetrikaCounter, error) {
	q := url.Values{
		"permission": {"own,edit"},
		"status":     {"Active"},
		"per_page":   {strconv.Itoa(metrikaCountersPerPage)},
	}
	var body struct {
		Counters []struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
			Site struct {
				Site string `json:"site"`
			} `json:"site2"`
		} `json:"counters"`
	}
	if err := y.metrikaRequest(ctx, http.MethodGet, "/counters?"+q.Encode(), accessToken, nil, &body); err != nil {
		return nil, fmt.Errorf("integrations metrika: list counters: %w", err)
	}
	out := make([]MetrikaCounter, 0, len(body.Counters))
	for _, c := range body.Counters {
		out = append(out, MetrikaCounter{ID: c.ID, Name: c.Name, Site: c.Site.Site})
	}
	return out, nil
}

// EnsureGoals заводит в счётчике недостающие цели и отвечает, сколько завёл и
// сколько уже было.
//
// Заведённой считается цель типа action с условием exact на тот же
// идентификатор — КАК БЫ ЕЁ НИ НАЗВАЛИ. Иначе второй форме с тем же счётчиком и
// автору, заведшему цель руками, доставались бы дубли: в отчётах Метрики это два
// столбца, каждый со своей половиной правды.
func (y *Yandex) EnsureGoals(ctx context.Context, accessToken string, counterID int64, goals []MetrikaGoal) (GoalsResult, error) {
	path := "/counter/" + strconv.FormatInt(counterID, 10) + "/goals"

	// Цели счётчика читаются СЫРЫМИ: решение «эта цель уже есть» не должно
	// зависеть от того, совпал ли разбор с сегодняшней формой ответа Метрики.
	//
	// Мина: цена ошибки несимметрична. Лишнее «уже есть» человек видит — цели не
	// завелись, он жалуется. Лишнее создание молча ломает собранную статистику:
	// Метрика на повторное создание цели с тем же условием не заводит вторую, а
	// заменяет существующую.
	// история — JOURNAL, «Слайс K. Затёртые цели и создание счётчика»
	//
	// Указатель, а не срез: ответ без поля goals (или с null) — незнакомый конверт,
	// и пустой список из него значил бы «целей нет» и три создания поверх
	// существующих. Пустой массив — законный ответ нового счётчика.
	var list struct {
		Goals *[]json.RawMessage `json:"goals"`
	}
	if err := y.metrikaRequest(ctx, http.MethodGet, path, accessToken, nil, &list); err != nil {
		return GoalsResult{}, fmt.Errorf("integrations metrika: list goals: %w", err)
	}
	if list.Goals == nil {
		return GoalsResult{}, fmt.Errorf("integrations metrika: list goals: в ответе нет поля goals")
	}

	var res GoalsResult
	for _, g := range goals {
		if goalPresent(*list.Goals, g.ID) {
			res.Existing++
			continue
		}
		payload := metrikaGoalEnvelope{Goal: metrikaGoalBody{
			Name:       g.Name,
			Type:       metrikaGoalType,
			Conditions: []metrikaCondition{{Type: "exact", URL: g.ID}},
		}}
		if err := y.metrikaRequest(ctx, http.MethodPost, path, accessToken, payload, nil); err != nil {
			// Счёт заведённого уезжает вместе с ошибкой: часть целей уже в
			// счётчике, и повтор их не тронет.
			return res, fmt.Errorf("integrations metrika: add goal %s: %w", g.ID, err)
		}
		res.Created++
	}
	return res, nil
}

// goalPresent — упоминается ли идентификатор в теле хоть одной цели счётчика.
//
// Поиск строкой по сырому JSON, а не по разобранным полям: идентификатор
// (`trillix_open`) не встречается в чужих целях случайно, зато любая наша цель
// несёт его в условии, как бы Метрика ни назвала окружающие поля. Совпадение по
// ИМЕНИ цели тоже сойдёт за «уже есть» — и это правильная сторона ошибки:
// невыполненное создание видно человеку, лишнее — нет.
func goalPresent(raw []json.RawMessage, id string) bool {
	needle := []byte(strconv.Quote(id))
	for _, g := range raw {
		if bytes.Contains(g, needle) {
			return true
		}
	}
	return false
}

// CreateCounter заводит в аккаунте новый счётчик и отдаёт его номер.
//
// Имя и сайт задаёт продукт (см. вызывающего): счётчик ставится ровно на страницу
// формы, а встроенная в чужой сайт форма отмечает цели в счётчике ТОГО сайта
// (спека §7) — указывать там домен автора нам нечем.
func (y *Yandex) CreateCounter(ctx context.Context, accessToken, name, site string) (MetrikaCounter, error) {
	payload := metrikaCounterEnvelope{Counter: metrikaCounterBody{Name: name, Site2: metrikaSite{Site: site}}}
	var body struct {
		Counter struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
			Site struct {
				Site string `json:"site"`
			} `json:"site2"`
		} `json:"counter"`
	}
	if err := y.metrikaRequest(ctx, http.MethodPost, "/counters", accessToken, payload, &body); err != nil {
		return MetrikaCounter{}, fmt.Errorf("integrations metrika: create counter: %w", err)
	}
	if body.Counter.ID <= 0 {
		return MetrikaCounter{}, fmt.Errorf("integrations metrika: create counter: пустой номер")
	}
	return MetrikaCounter{ID: body.Counter.ID, Name: body.Counter.Name, Site: body.Counter.Site.Site}, nil
}

// metrikaCounterEnvelope — тело создания счётчика: Метрика ждёт объект в поле counter.
type metrikaCounterEnvelope struct {
	Counter metrikaCounterBody `json:"counter"`
}

type metrikaCounterBody struct {
	Name  string      `json:"name"`
	Site2 metrikaSite `json:"site2"`
}

type metrikaSite struct {
	Site string `json:"site"`
}

// metrikaGoalEnvelope — тело создания цели: Метрика ждёт объект в поле goal.
type metrikaGoalEnvelope struct {
	Goal metrikaGoalBody `json:"goal"`
}

type metrikaGoalBody struct {
	Name       string             `json:"name"`
	Type       string             `json:"type"`
	Conditions []metrikaCondition `json:"conditions"`
}

// metrikaCondition — условие цели. У JavaScript-события в поле url лежит
// идентификатор события, а не адрес страницы: так устроен API.
type metrikaCondition struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

// metrikaRequest — поход в API управления. Тело отказа раскрывается (explain):
// там лежит причина вроде «нет доступа к счётчику», и без неё в логе остаётся
// трёхзначное число. До экрана этот текст не доезжает — он английский; человеку
// отвечает metrikaRefusal.
func (y *Yandex) metrikaRequest(ctx context.Context, method, path, accessToken string, in any, out any) error {
	var body io.Reader
	if in != nil {
		data, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("сборка тела запроса: %w", err)
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, y.metrikaURL+path, body)
	if err != nil {
		return fmt.Errorf("сборка запроса: %w", err)
	}
	// Заголовком, а не query-параметром: токен не должен оседать в логах прокси.
	req.Header.Set("Authorization", "OAuth "+accessToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return providerRequest(y.http, req, out, true)
}
