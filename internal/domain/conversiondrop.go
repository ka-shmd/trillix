package domain

import "math"

// Падение конверсии формы (спека design/analytics-v2.md §9, решение владельца Р6):
// последние 7 суток против 28 суток до них. Порог объёма и значимость — чтобы форма
// на тридцать визитов в неделю не будила владельца каждой случайной просадкой.
const (
	DropRecentDays    = 7
	DropBaseDays      = 28
	DropMinRecent     = 100  // визитов в неделе
	DropMinBase       = 200  // визитов в базе
	DropMinRelative   = 0.30 // падение относительно базовой конверсии
	dropZCriticalP001 = 2.326
)

// ConversionWindow — визиты и отправившие за неделю и за базовое окно.
type ConversionWindow struct {
	RecentVisits, RecentSubmitted int
	BaseVisits, BaseSubmitted     int
}

// Rates — конверсия недели и базы в процентах, как их пишет уведомление.
func (w ConversionWindow) Rates() (recent, base int) {
	return int(math.Round(rate(w.RecentSubmitted, w.RecentVisits) * 100)),
		int(math.Round(rate(w.BaseSubmitted, w.BaseVisits) * 100))
}

// Dropped — упала ли конверсия заметно и не случайно: объёмы над порогами, неделя
// ниже базы на DropMinRelative и больше, и разница значима — односторонний z-тест
// двух долей, p < 0,01.
func (w ConversionWindow) Dropped() bool {
	if w.RecentVisits < DropMinRecent || w.BaseVisits < DropMinBase {
		return false
	}
	pr, pb := rate(w.RecentSubmitted, w.RecentVisits), rate(w.BaseSubmitted, w.BaseVisits)
	if pb == 0 || pr > pb*(1-DropMinRelative) {
		return false
	}
	n1, n2 := float64(w.RecentVisits), float64(w.BaseVisits)
	pooled := float64(w.RecentSubmitted+w.BaseSubmitted) / (n1 + n2)
	se := math.Sqrt(pooled * (1 - pooled) * (1/n1 + 1/n2))
	if se == 0 {
		return false
	}
	return (pb-pr)/se >= dropZCriticalP001
}

func rate(part, whole int) float64 {
	if whole == 0 {
		return 0
	}
	return float64(part) / float64(whole)
}
