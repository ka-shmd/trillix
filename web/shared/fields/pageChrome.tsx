import type { CSSProperties } from 'react'

import { type FormCover, type FormLogo, coverY } from '@entities/formSchema'

import { mediaSrc } from './media'

// Хром страницы формы — обложка и логотип. Общий вывод для трёх поверхностей
// (полотно редактора, превью билдера, публичный рендерер): вид один, разъезжаться
// ему нельзя, как и виду полей.
//
// Компонентов два, а не один, потому что в DOM они СТОЯТ ПО РАЗНЫЕ СТОРОНЫ границы
// страницы: обложка — сестра .rf-page (во всю ширину), логотип — её первый ребёнок
// (по левому краю колонки). Один компонент вернуть такое не может, а обёртка ради
// симметрии заставила бы .rf-page потерять роль корня страницы.
//
// Картинки декоративны (alt=""), как и картинка блока: смысл страницы несут
// заголовок и вопросы, а скринридеру логотип диктовать нечего.

// РАЗМЕРЫ ХРОМА — ИНЛАЙНОВЫМИ ПЕРЕМЕННЫМИ НА САМ ЭЛЕМЕНТ, а не классами и не через
// designToVars. Три довода, каждый самостоятельный: числа непрерывные (классов на них
// не напасёшься); это свойства ДОКУМЕНТА (cover/logo), а не оформления, и в контракт
// переменных оформления, который сверяется с Go, им попадать незачем; правило нахлёста
// .rf-logo--over считает половину высоты логотипа — переменную оно обязано видеть на
// том же элементе, где объявлено.
//
// Незаданное не печатается вовсе — дефолт живёт в :root fields.css (100×100, радиус 50,
// обложка 25vh). Тот же контракт, что у оформления: отсутствие ключа значит дефолт.
function chromeVars(values: Record<string, number | undefined>, unit: string): CSSProperties {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) out[name] = `${value}${unit}`
  }
  return out as CSSProperties
}

// CoverBand — полоса обложки: цвет или картинка. Ничего не рисует, если обложки
// нет: пустой полосы «на будущее» быть не должно.
export function CoverBand({ cover }: { cover?: FormCover }) {
  if (!cover) return null
  // Высота — доля высоты окна, поэтому единица vh, а не px (см. --rf-cover-h).
  const size = chromeVars({ '--rf-cover-h': cover.height }, 'vh')
  if (cover.imageKey) {
    return (
      <div className="rf-cover" style={size}>
        <img
          className="rf-cover-img"
          src={mediaSrc(cover.imageKey)}
          alt=""
          // Нативный drag картинки выключен, и это НЕ косметика: он перебивает жест
          // «изменить положение» в редакторе. Браузер начинает своё перетаскивание
          // через несколько пикселей, снимает захват указателя и шлёт pointercancel —
          // сдвиг обрывается почти сразу, а за курсором едет призрак картинки. На
          // публичной странице он тоже не нужен: обложка — фон, а не файл на вынос.
          draggable={false}
          // Точка фокуса по вертикали: 0 — прижата верхом, 100 — низом. Проценты
          // по горизонтали всегда 50 — обложка шире, чем высока.
          style={{ objectPosition: `50% ${coverY(cover)}%` }}
        />
      </div>
    )
  }
  // Цвет — сплошная заливка той же полосы. Схема хранит строгий #rrggbb, поэтому в
  // inline-style уезжает шесть шестнадцатеричных цифр, а не свободный CSS (ADR §10).
  return <div className="rf-cover" style={{ ...size, backgroundColor: cover.color }} />
}

// LogoMark — квадрат логотипа. over = «подо мной обложка, вылезти на неё»: это
// свойство СТРАНИЦЫ, а не логотипа, поэтому приходит пропом, а не выводится здесь.
export function LogoMark({ logo, over = false }: { logo?: FormLogo; over?: boolean }) {
  if (!logo) return null
  const size = chromeVars(
    {
      '--rf-logo-w': logo.width,
      '--rf-logo-h': logo.height,
      '--rf-logo-radius': logo.radius,
    },
    'px',
  )
  return (
    <div className={over ? 'rf-logo rf-logo--over' : 'rf-logo'} style={size}>
      {/* draggable=false по той же причине, что у обложки: логотип — знак страницы,
          а не файл, который куда-то тащат. */}
      <img className="rf-logo-img" src={mediaSrc(logo.imageKey)} alt="" draggable={false} />
    </div>
  )
}

// pageClass — класс корня страницы с учётом обложки. Функция, а не тернарник по
// месту: правило «есть обложка → страница поджимает верхний отступ» одно на три
// поверхности, и разъехаться оно не должно.
export function pageClass(cover: FormCover | undefined, extra = ''): string {
  return ['rf-page', cover ? 'rf-covered' : '', extra].filter(Boolean).join(' ')
}
