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

	var list struct {
		Goals []struct {
			Type       string `json:"type"`
			Conditions []struct {
				Type string `json:"type"`
				URL  string `json:"url"`
			} `json:"conditions"`
		} `json:"goals"`
	}
	if err := y.metrikaRequest(ctx, http.MethodGet, path, accessToken, nil, &list); err != nil {
		return GoalsResult{}, fmt.Errorf("integrations metrika: list goals: %w", err)
	}
	have := map[string]bool{}
	for _, g := range list.Goals {
		if g.Type != metrikaGoalType {
			continue
		}
		for _, c := range g.Conditions {
			if c.Type == "exact" {
				have[c.URL] = true
			}
		}
	}

	var res GoalsResult
	for _, g := range goals {
		if have[g.ID] {
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
