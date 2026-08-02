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

// CoverBand — полоса обложки: цвет или картинка. Ничего не рисует, если обложки
// нет: пустой полосы «на будущее» быть не должно.
export function CoverBand({ cover }: { cover?: FormCover }) {
  if (!cover) return null
  if (cover.imageKey) {
    return (
      <div className="rf-cover">
        <img
          className="rf-cover-img"
          src={mediaSrc(cover.imageKey)}
          alt=""
          // Точка фокуса по вертикали: 0 — прижата верхом, 100 — низом. Проценты
          // по горизонтали всегда 50 — обложка шире, чем высока.
          style={{ objectPosition: `50% ${coverY(cover)}%` }}
        />
      </div>
    )
  }
  // Цвет — сплошная заливка той же полосы. Схема хранит строгий #rrggbb, поэтому в
  // inline-style уезжает шесть шестнадцатеричных цифр, а не свободный CSS (ADR §10).
  return <div className="rf-cover" style={{ backgroundColor: cover.color }} />
}

// LogoMark — квадрат логотипа. over = «подо мной обложка, вылезти на неё»: это
// свойство СТРАНИЦЫ, а не логотипа, поэтому приходит пропом, а не выводится здесь.
export function LogoMark({ logo, over = false }: { logo?: FormLogo; over?: boolean }) {
  if (!logo) return null
  return (
    <div className={over ? 'rf-logo rf-logo--over' : 'rf-logo'}>
      <img className="rf-logo-img" src={mediaSrc(logo.imageKey)} alt="" />
    </div>
  )
}

// pageClass — класс корня страницы с учётом обложки. Функция, а не тернарник по
// месту: правило «есть обложка → страница поджимает верхний отступ» одно на три
// поверхности, и разъехаться оно не должно.
export function pageClass(cover: FormCover | undefined, extra = ''): string {
  return ['rf-page', cover ? 'rf-covered' : '', extra].filter(Boolean).join(' ')
}
