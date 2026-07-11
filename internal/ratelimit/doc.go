// Package ratelimit — in-memory лимитеры запросов (token bucket по ключу).
// Один инстанс, без Redis; интерфейс потребителя позволит заменить реализацию
// при переезде на несколько инстансов (ARCHITECTURE §4.4).
package ratelimit
