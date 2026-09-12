// Фирменные знаки сервисов интеграций. Инлайн-SVG, а не глиф lucide и не файл:
// каталог узнаётся по логотипу, серый значок таблицы этого не даёт, а внешний
// источник в проде режет CSP (`default-src 'self'`).
//
// Знак — не контрол, и правило «интерфейс кабинета только из shadcn» его не
// касается: рисовать логотип чужого сервиса больше нечем.

// Google Таблицы: зелёный лист с загнутым углом и белой таблицей внутри.
export function GoogleSheetsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Google Таблицы">
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5Z" fill="#0F9D58" />
      {/* Загнутый угол — та же фигура, но темнее: без него лист читается просто
          зелёным прямоугольником. */}
      <path d="M14 2v5h5l-5-5Z" fill="#0B8043" />
      <rect x="8" y="10.5" width="8" height="7" rx="0.4" fill="#fff" />
      <path d="M12 10.5v7M8 12.9h8M8 15.2h8" stroke="#0F9D58" strokeWidth="0.9" />
    </svg>
  )
}

// Вебхук — не сервис, и фирменного знака у него нет: рисуем предметный —
// «запрос уходит из формы наружу». Цвет берётся токеном действия (`--primary`),
// а не литералом: у знака нет своего бренда, и в тёмной теме он обязан жить.
export function WebhookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Вебхук">
      <rect x="2" y="4" width="13" height="16" rx="2.5" className="fill-primary/15" />
      <path
        d="M5.5 8.5h6M5.5 12h6M5.5 15.5h3.5"
        className="stroke-primary"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* Стрелка наружу: она и отличает вебхук от «ещё одной таблицы». */}
      <path
        d="M14 12h7m0 0-3-3m3 3-3 3"
        className="stroke-primary"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}
