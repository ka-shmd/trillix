package domain

import "sort"

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
	// Reached — дошли до страницы. У визита с путём — открывали её; у визита без
	// пути — закончили на её вопросах или дальше по документу.
	Reached int
	// DroppedHere — остановились на её вопросах и форму НЕ отправили.
	DroppedHere int
	// TimeSec — медиана времени на странице у тех, кто пошёл дальше; TimeSamples —
	// её знаменатель (0 — данных нет, TimeSec тогда ноль и ничего не значит).
	TimeSec     int
	TimeSamples int
	// LeftTimeSec — медиана времени на странице у ушедших с неё: от открытия до
	// последнего бикона визита. LeftSamples — её знаменатель.
	LeftTimeSec int
	LeftSamples int
}

// PathCount — визиты с путём (спека design/analytics-v2.md §4): дальняя точка, исход и
// набор первых вопросов открытых страниц. Подмножество LastBlockCount — те же визиты
// там уже посчитаны.
type PathCount struct {
	LastBlockID string
	Submitted   bool
	Blocks      []string
	Visits      int
}

// PageSpan — корзина гистограммы времени на странице. PageBlock — первый вопрос
// страницы из пути, пустой — первая страница документа. LastBlock заполнен только у
// ушедших с первой страницы без пути: такой визит мог быть собран до пути на дальней
// странице, и верить корзине можно, лишь если дальняя точка на первой странице.
type PageSpan struct {
	PageBlock string
	LastBlock string
	Left      bool
	Sec       int
	Visits    int
}

// FunnelData — сырьё воронки из базы.
type FunnelData struct {
	// Counts — ВСЕ визиты периода по дальней точке и исходу.
	Counts []LastBlockCount
	// Paths и Spans нужны только многостраничной форме.
	Paths []PathCount
	Spans []PageSpan
}

// BuildFunnel собирает воронку.
//
// Visits и Submitted ВЫВОДЯТСЯ из Counts, а не приходят отдельными счётчиками:
// Counts — это полная разбивка визитов формы (`GROUP BY last_block_id, submitted`),
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
// pages — страницы формы (PageOrder), nil у одностраничной. Если они есть:
//   - вопросы переставляются по страницам: вопрос, оставшийся только в прежней
//     версии, встаёт в конец СВОЕЙ страницы, а не в конец формы, — иначе «дошли» у
//     вопросов последней страницы включало бы ушедших с первой;
//   - визит с путём дошёл до страницы, только если открывал её (или остановился на
//     ней); первую страницу документа видели все. Прыгнувший логикой с первой
//     страницы на четвёртую вторую и третью не проходил;
//   - визит без пути — по порядку документа, как до пути: собран раньше или не
//     уходил дальше первой страницы, и во втором случае правила совпадают.
func BuildFunnel(questions []Question, pages []Page, d FunnelData) Funnel {
	var f Funnel

	// droppedAt — не отправившие, закончившие на блоке (для DroppedHere).
	droppedAt := make(map[string]int, len(d.Counts))
	type outcome struct {
		block     string
		submitted bool
	}
	ended := make(map[outcome]int, len(d.Counts))
	for _, c := range d.Counts {
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
		ended[outcome{c.BlockID, c.Submitted}] += c.Visits
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

	if len(pages) == 0 {
		// Reached считается с конца: дошедшие до вопроса i — это закончившие на нём
		// плюс все, кто оказался дальше. Один проход вместо вложенного цикла.
		running := 0
		for i := len(f.Steps) - 1; i >= 0; i-- {
			running += ended[outcome{f.Steps[i].BlockID, false}] + ended[outcome{f.Steps[i].BlockID, true}]
			f.Steps[i].Reached = running
		}
		return f
	}

	pos := make(map[string]int, len(f.Steps))
	for i, s := range f.Steps {
		pos[s.BlockID] = i
	}
	pageOf := make(map[string]int, len(f.Steps))
	firstPage := -1 // первая страница документа среди шагов: её видели все
	for i, p := range pages {
		for _, id := range p.QuestionIDs {
			pageOf[id] = i
		}
		if p.Key == "" {
			firstPage = i
		}
	}

	// Группы визитов: у визита без пути seen == nil (порядок документа), у визита с
	// путём — набор открытых страниц. Визиты без пути — это все минус визиты с путём.
	type group struct {
		last   int // позиция дальней точки в шагах
		visits int
		seen   []bool
	}
	var groups []group
	for _, pc := range d.Paths {
		last, ok := pos[pc.LastBlockID]
		if !ok {
			continue // дальняя точка неизвестна: в шаги визит не входит, как и без пути
		}
		ended[outcome{pc.LastBlockID, pc.Submitted}] -= pc.Visits
		seen := make([]bool, len(pages))
		seen[pageOf[pc.LastBlockID]] = true
		if firstPage >= 0 {
			seen[firstPage] = true
		}
		for _, b := range pc.Blocks {
			if pg, ok := pageOf[b]; ok {
				seen[pg] = true
			}
		}
		groups = append(groups, group{last: last, visits: pc.Visits, seen: seen})
	}
	for o, n := range ended {
		if last, ok := pos[o.block]; ok && n > 0 {
			groups = append(groups, group{last: last, visits: n})
		}
	}

	f.Pages = make([]FunnelPage, len(pages))
	for i, p := range pages {
		f.Pages[i] = FunnelPage{Key: p.Key, Label: p.Label}
	}
	for i := range f.Steps {
		pg := pageOf[f.Steps[i].BlockID]
		f.Pages[pg].DroppedHere += f.Steps[i].DroppedHere
	}
	for _, g := range groups {
		lastPage := pageOf[f.Steps[g.last].BlockID]
		for i := 0; i <= g.last; i++ {
			if g.seen == nil || g.seen[pageOf[f.Steps[i].BlockID]] {
				f.Steps[i].Reached += g.visits
			}
		}
		for pg := range f.Pages {
			if (g.seen == nil && pg <= lastPage) || (g.seen != nil && g.seen[pg]) {
				f.Pages[pg].Reached += g.visits
			}
		}
	}

	applyPageTimes(f.Pages, pageOf, firstPage, d.Spans)
	return f
}

// applyPageTimes раскладывает гистограммы времени по страницам и берёт медианы.
// Гистограмма, а не медиана из базы: у страницы в разных версиях может быть разный
// первый вопрос, и медианы по вопросам не складываются.
func applyPageTimes(pages []FunnelPage, pageOf map[string]int, firstPage int, spans []PageSpan) {
	type key struct {
		page int
		left bool
	}
	hist := make(map[key]map[int]int)
	for _, s := range spans {
		pg := firstPage
		if s.PageBlock != "" {
			p, ok := pageOf[s.PageBlock]
			if !ok {
				continue
			}
			pg = p
		} else if s.Left {
			// Ушёл без пути: верим, только если дальняя точка на первой странице.
			if p, ok := pageOf[s.LastBlock]; !ok || p != firstPage {
				continue
			}
		}
		if pg < 0 {
			continue // первая страница документа без вопросов — не шаг
		}
		k := key{pg, s.Left}
		if hist[k] == nil {
			hist[k] = make(map[int]int)
		}
		hist[k][s.Sec] += s.Visits
	}
	for k, h := range hist {
		med, n := histMedian(h)
		if k.left {
			pages[k.page].LeftTimeSec, pages[k.page].LeftSamples = med, n
		} else {
			pages[k.page].TimeSec, pages[k.page].TimeSamples = med, n
		}
	}
}

// histMedian — нижняя медиана гистограммы «секунды → число визитов» и её знаменатель.
func histMedian(h map[int]int) (median, n int) {
	secs := make([]int, 0, len(h))
	for s, c := range h {
		secs = append(secs, s)
		n += c
	}
	sort.Ints(secs)
	target := (n - 1) / 2
	for _, s := range secs {
		target -= h[s]
		if target < 0 {
			return s, n
		}
	}
	return 0, n
}
