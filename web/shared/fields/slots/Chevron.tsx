// Шеврон ленты дат. Рисуется здесь, а не берётся иконочным набором: две линии не стоят
// зависимости, которую качал бы каждый респондент формы с записью.
//
// Отдельным файлом, потому что читателей двое: живой пикер и заглушка вида для кабинета
// (SlotStub). Импортируй его стрелку из SlotPicker — и в бандл кабинета уехал бы весь
// пикер с холдами и отказами ради двух путей в svg.
export function Chevron({ back = false }: { back?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={back ? 'M15 5 8 12l7 7' : 'M9 5l7 7-7 7'} />
    </svg>
  )
}
