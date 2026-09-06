import { useMemo } from 'react'

import { Chevron } from './Chevron'
import { useCols } from './cols'
import { dayKey, dayStrip, fullDayLabel, monthLabel } from './slotList'
import './slots.css'

// ЗАГЛУШКА ВИДА ЗАПИСИ — то же самое, что увидит респондент, но без выбора.
//
// Живого свободного времени в кабинете нет и быть не должно: расписание — свойство
// ФОРМЫ, оно правится в попапе строки, а его свободные точки считает публичная ручка по
// slug опубликованной формы. Полотно редактора и превью при этом обязаны показывать
// вопрос ТАКИМ, каким он приедет к респонденту, — иначе автор ставит блок вслепую.
//
// ⚠ ЭТО МАКЕТ, А НЕ РАСПИСАНИЕ АВТОРА. Даты настоящие (от сегодня вперёд), времена —
// образец: часы приёма живут на сервере, и запросить их полотну неоткуда. Автор видит
// раскладку и плотность, а не свои окна.
//
// ⚠ НИ ОДНОЙ КНОПКИ ВНУТРИ. Строка записи на полотне — ОБЪЕКТ (каретка встаёт на неё
// саму, кольцом), и фокусируемый элемент внутри увёл бы у полотна Tab. Поэтому div'ы с
// теми же классами, а не выключенный пикер: `disabled` снимает клик, но не фокус, а
// `pointer-events: none` — наоборот.
//
// В рендерер этот файл не едет: его импортирует только кабинет (полотно напрямую,
// превью — через SlotStubProvider). Разметка пикера в общем чанке формы означала бы
// второй его экземпляр у каждого респондента.

// SPAN — сколько дней в ленте заглушки. Две недели: больше, чем помещается в самую
// широкую страницу (colsFor), — иначе на широком полотне лента упёрлась бы в свой конец
// и стала короче настоящей.
const SPAN = 14

// Времена образца: рабочий день с перерывом, как у большинства расписаний. Ровно то же
// число кнопок, что даёт обычный приём по часу, — плотность сетки должна быть честной.
const TIMES = ['10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00']

export function SlotStub() {
  const { cols, ref } = useCols()
  // Лента считается из двух ключей — первого и последнего дня: середину dayStrip
  // заполняет сам, тем же кодом, что и у респондента.
  const cells = useMemo(() => {
    const from = new Date()
    from.setHours(0, 0, 0, 0)
    const to = new Date(from)
    to.setDate(from.getDate() + SPAN - 1)
    return dayStrip([
      { key: dayKey(from), slots: [] },
      { key: dayKey(to), slots: [] },
    ])
  }, [])
  const page = cells.slice(0, cols)
  const first = page[0]

  return (
    <div className="rf-slots rf-slots--stub" aria-hidden="true">
      <section>
        <div className="rf-slots-head">
          <p className="rf-slots-month">{monthLabel(page)}</p>
          <div className="rf-slots-turn">
            <span className="rf-slots-arrow">
              <Chevron back />
            </span>
            <span className="rf-slots-arrow">
              <Chevron />
            </span>
          </div>
        </div>
        <div
          ref={ref}
          className="rf-slots-week"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {page.map((c, i) => (
            <div
              key={c.key}
              className={i === 0 ? 'rf-slots-date rf-slots-date--on' : 'rf-slots-date'}
            >
              <span className="rf-slots-num">{c.num}</span>
              <span className="rf-slots-dow">{c.weekday}</span>
            </div>
          ))}
        </div>
      </section>

      {first && (
        <section className="rf-slots-hours">
          <p className="rf-slots-chosen">{fullDayLabel(first)}</p>
          <div className="rf-slots-times">
            {TIMES.map((t) => (
              <div key={t} className="rf-slots-time">
                {t}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
