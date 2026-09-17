// Строка бланка: подпись и сразу за ней значение, как в шапке письма («Тема: …»).
// Подпись не колонка: значение начинается вплотную к ней, поэтому строка читается
// фразой, а поле не отъезжает от своего названия на полэкрана.
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-2 border-b px-3 last:border-b-0">
      <span className="shrink-0 text-sm text-muted-foreground">{label}:</span>
      {children}
    </div>
  )
}
