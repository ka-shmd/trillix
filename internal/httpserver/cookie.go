package httpserver

// HostCookie — имя cookie кабинета на контуре. С флагом Secure имя получает
// префикс `__Host-`: такую cookie браузер принимает, только если у неё нет
// Domain, есть Secure и путь «/». Поэтому соседний поддомен — домен форм, где
// исполняется счётчик Метрики автора, — не может подложить кабинету cookie с тем
// же именем (ADR §10). Без Secure (dev по http) префикса нет: браузер отверг бы
// такую cookie целиком.
//
// Читать и ставить cookie нужно именем отсюда. Имя, собранное руками, в dev и в
// тестах (без Secure) совпадёт с выставленным, а на прод-контуре молча не найдёт
// cookie — сторож `make check-docs` пускает чтение и запись только из cookies.go.
func HostCookie(name string, secure bool) string {
	if secure {
		return "__Host-" + name
	}
	return name
}
