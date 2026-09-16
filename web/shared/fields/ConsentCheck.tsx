// Галочка согласия под кнопкой отправки (docs/design/privacy-consent.md §3.5). Одна на две
// поверхности: форма респондента (FormView) и превью билдера (PreviewPane) — автор обязан
// видеть в превью то, что увидит респондент.
//
// Галочка — только про согласие, а политика — отдельной строкой: согласие оформляется
// отдельно от иных документов (ч. 1 ст. 9 152-ФЗ), и «ознакомлен с политикой» в ту же
// отметку не вписывается. Пустая по умолчанию: предзаполненная отметка согласием не
// считается, поэтому состояние живёт у вызывающего в памяти и в черновик не попадает.
//
// Ссылка внутри <label> отметку не переключает: активация метки не срабатывает на
// интерактивном потомке. У респондента открывается в новой вкладке — и из фрейма
// встраивания тоже, иначе документ заменил бы форму посреди заполнения. В превью
// (`hrefs` нет) ссылка выглядит ссылкой, но никуда не ведёт — тот же приём, что у
// ссылок в тексте (richText.tsx, `inert`): клик уводил бы автора с превью.
//
// Текст обеих строк несёт класс rf-consent, а контейнеры — свои: всех их держит сторож
// после CSS автора (customCss.ts). rf-consent не вешается на flex-метку — сторож
// возвращает ему display браузера.
export function ConsentCheck({
  hrefs,
  checked,
  onChange,
  error,
  disabled,
}: {
  hrefs?: { consent: string; policy: string }
  checked: boolean
  onChange: (checked: boolean) => void
  error: boolean
  disabled: boolean
}) {
  const link = (kind: 'consent' | 'policy', text: string) => (
    <a
      className="rf-link"
      href={hrefs ? hrefs[kind] : '#'}
      target="_blank"
      rel="noopener"
      onClick={hrefs ? undefined : (e) => e.preventDefault()}
    >
      {text}
    </a>
  )
  return (
    <div className="rf-consent-box">
      <label className="rf-consent-check">
        <input
          className="rf-mark rf-mark--check"
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
          disabled={disabled}
          aria-invalid={error || undefined}
          aria-describedby={error ? 'rf-consent-error' : undefined}
        />
        <span className="rf-consent">
          Я даю {link('consent', 'согласие на обработку персональных данных')}
        </span>
      </label>
      {error && (
        <p className="rf-error" id="rf-consent-error" role="alert">
          Отметьте согласие, чтобы отправить форму.
        </p>
      )}
      <p className="rf-consent">{link('policy', 'Политика обработки персональных данных')}</p>
    </div>
  )
}
