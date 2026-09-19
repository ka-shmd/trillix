package domain

// Воронка формы (фаза 8.5 шаг 6б): на каком вопросе люди уходят.
//
// Шаг 6 дал владельцу дробь «187 просмотров → 12 ответов»: она говорит, что форма
// теряет людей, но молчит, где именно. Воронка отвечает на это, и из неё следует
// конкретное действие — убрать вопрос или сделать необязательным.
//
// Чистая свёртка: ни HTTP, ни SQL. На вход — раскладка визитов по самой дальней
// точке (её считает Postgres одним GROUP BY, размер результата — число вопросов) и
// модель вопросов формы по всем версиям (QuestionOrder). На выход — шаги воронки.

// LastBlockCount — сколько визитов закончилось на этом блоке. BlockID пуст у тех,
// кто не тронул ни одного вопроса.
//
// Submitted разделяет два разных исхода на ОДНОМ и том же блоке: отправивший форму
// тоже остановился на последнем поле, которого коснулся. Считать его отвалом значит
// обвинять вопрос, который работает.
type LastBlockCount struct {
	BlockID   string
	Submitted bool
	Visits    int
}

// FunnelStep — шаг воронки: один вопрос формы.
type FunnelStep struct {
	BlockID string
	Label   string
	// Page — ключ страницы вопроса (Page.Key); у одностраничной формы пуст.
	Page string
	// Reached — сколько визитов дошло ДО этого вопроса: остановившиеся на нём плюс
	// все, кто оказался дальше, включая отправивших. Невозрастает по шагам.
	Reached int
	// DroppedHere — сколько визитов остановилось ИМЕННО здесь и форму НЕ отправило.
	// Это и есть ответ на вопрос «какой вопрос убивает форму». Отправившие сюда не
	// входят, даже если это поле было для них последним.
	DroppedHere int
}

// Funnel — воронка формы целиком.
type Funnel struct {
	// Visits — всего визитов (верх воронки).
	Visits int
	// Submitted — сколько визитов закончились отправкой (низ воронки).
	Submitted int
	// LeftBeforeFirst — ушли, не тронув ни одного вопроса и не отправив. Отдельным
	// числом, а не шагом: это не «отвал на вопросе», а «форма не начата вовсе», и
	// лечится другим (заголовком, длиной формы, ожиданиями от ссылки), чем страшный
	// вопрос внутри.
	LeftBeforeFirst int
	Steps           []FunnelStep
	// Pages — шаги-страницы многостраничной формы (PageOrder); пусто у одностраничной.
	// Вопросы в Steps тогда идут по страницам, и вопросы одной страницы стоят подряд.
	Pages []FunnelPage
}

// FunnelPage — шаг воронки многостраничной формы: страница целиком.
type FunnelPage struct {
	Key   string
	Label string
	// Reached — дошли до страницы: закончившие визит на её вопросах или дальше.
	Reached int
	// DroppedHere — остановились на её вопросах и форму НЕ отправили.
	DroppedHere int
}

// BuildFunnel собирает воронку.
//
// Visits и Submitted ВЫВОДЯТСЯ из counts, а не приходят отдельными счётчиками:
// counts — это полная разбивка визитов формы (`GROUP BY last_block_id, submitted`),
// поэтому сумма всех групп равна общему числу визитов, а сумма групп с Submitted —
// числу конверсий. Второй запрос за теми же числами был лишним сканом на каждом
// открытии воронки; заодно ушла возможность рассогласования между двумя выборками.
//
// Неизвестный BlockID (блока нет ни в одной версии формы) в шаги не попадает и к
// соседнему вопросу НЕ приписывается: id визита выбирает клиент, ручка публична на
// запись, и подделанное значение не должно искажать чужой шаг. Такие визиты
// остаются в Visits (они были), но ни в один Reached не входят — из-за чего
// Reached первого шага может быть меньше, чем Visits − LeftBeforeFirst. Это
// честнее, чем тихо прибавить мусор к реальному вопросу.
//
// pages — страницы формы (PageOrder), nil у одностраничной. Если они есть, вопросы
// переставляются по страницам: вопрос, оставшийся только в прежней версии, встаёт в
// конец СВОЕЙ страницы, а не в конец формы, — иначе «дошли» у вопросов последней
// страницы включало бы ушедших с первой.
func BuildFunnel(questions []Question, pages []Page, counts []LastBlockCount) Funnel {
	var f Funnel

	// endedAt — все закончившие на блоке (для Reached), droppedAt — только не
	// отправившие (для DroppedHere). Разные множества, поэтому две карты.
	endedAt := make(map[string]int, len(counts))
	droppedAt := make(map[string]int, len(counts))
	for _, c := range counts {
		f.Visits += c.Visits
		if c.Submitted {
			f.Submitted += c.Visits
		}
		if c.BlockID == "" {
			// Отправить, не тронув ни одного поля, можно у формы, где все вопросы
			// необязательны: человек сразу жмёт «Отправить». Это не уход.
			if !c.Submitted {
				f.LeftBeforeFirst += c.Visits
			}
			continue
		}
		endedAt[c.BlockID] += c.Visits
		if !c.Submitted {
			droppedAt[c.BlockID] += c.Visits
		}
	}

	f.Steps = make([]FunnelStep, 0, len(questions))
	if len(pages) == 0 {
		for _, q := range questions {
			f.Steps = append(f.Steps, FunnelStep{BlockID: q.ID, Label: q.Label, DroppedHere: droppedAt[q.ID]})
		}
	} else {
		labels := make(map[string]string, len(questions))
		for _, q := range questions {
			labels[q.ID] = q.Label
		}
		for _, p := range pages {
			for _, id := range p.QuestionIDs {
				f.Steps = append(f.Steps, FunnelStep{BlockID: id, Label: labels[id], Page: p.Key, DroppedHere: droppedAt[id]})
			}
		}
	}

	// Reached считается с конца: дошедшие до вопроса i — это закончившие на нём плюс
	// все, кто оказался дальше. Один проход вместо вложенного цикла.
	running := 0
	for i := len(f.Steps) - 1; i >= 0; i-- {
		running += endedAt[f.Steps[i].BlockID]
		f.Steps[i].Reached = running
	}

	// Вопросы страницы стоят подряд, поэтому «дошли до страницы» — это «дошли до её
	// первого вопроса», а отвал страницы — сумма отвалов её вопросов.
	if len(pages) > 0 {
		f.Pages = make([]FunnelPage, len(pages))
		byKey := make(map[string]int, len(pages))
		for i, p := range pages {
			f.Pages[i] = FunnelPage{Key: p.Key, Label: p.Label}
			byKey[p.Key] = i
		}
		for i := len(f.Steps) - 1; i >= 0; i-- {
			pg := &f.Pages[byKey[f.Steps[i].Page]]
			pg.Reached = f.Steps[i].Reached
			pg.DroppedHere += f.Steps[i].DroppedHere
		}
	}
	return f
}
