import { useEffect, useRef } from 'react'

// Глобальные (оконные) шорткаты полотна — история `Mod+Z`/`Mod+Y` (BuilderScreen) и
// шпаргалка `Mod+/` (SlashEditor). Оба слушают `window` и ловят событие ОТКУДА УГОДНО,
// и для полотна это осознанно: `Mod+Z` внутри строки откатывает документ, а не набор
// символов (так ведут себя Notion и Tally, §3.1 EDITOR.md).
//
// С фазы 16 у блока появился попап настроек, и то же правило в его полях читается
// иначе: «правлю поле — теряю документ». `Mod+Z` в поле имени вопроса откатил бы
// последнюю правку ДОКУМЕНТА, а автор ждёт отмены своего ввода; `Mod+/` в поиске типа
// открыл бы шпаргалку поверх попапа вместо литерала «/».
//
// Граница проходит по ПОЛЮ ВО ВСПЛЫВАЮЩЕМ СЛОЕ, а не по слою целиком — и это не
// осторожность, а требование: шпаргалка сама диалог, а `Mod+/` обязан её закрывать
// (тогл). Гасить весь слой значило бы запереть открытую шпаргалку.
export function inOverlayField(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false
  const field = target.closest('input, textarea, [contenteditable="true"]')
  if (field === null) return false
  // Поповеры shadcn несут data-slot, диалоги (свои и Radix) — role="dialog".
  // Поверхности полотна не внутри ни того ни другого, поэтому правило их не задевает.
  return field.closest('[data-slot="popover-content"], [role="dialog"]') !== null
}

// useGlobalChord — оконный слушатель клавиш с этим единственным правилом цели.
// Существует затем, чтобы правило было ОДНО и лежало в одном месте: два слушателя,
// каждый со своей проверкой, разъезжаются молча — один продолжит съедать ввод в
// попапе, и заметит это не тест, а автор, потерявший правку.
//
// Обработчик держится в ref: слушатель ставится один раз на всё время экрана, а
// колбэк переcоздаётся каждым рендером (он замкнут на стор и фокус-движок).
export function useGlobalChord(onKey: (e: KeyboardEvent) => void) {
  const ref = useRef(onKey)
  // Синхронизация ref'а — эффектом, а не записью в теле (правило react-hooks/refs):
  // эффект без списка зависимостей выполняется после КАЖДОГО рендера, то есть раньше
  // любого нажатия, а слушатель остаётся тем же.
  useEffect(() => {
    ref.current = onKey
  })

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (inOverlayField(e.target)) return
      ref.current(e)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
}
