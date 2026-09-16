import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ImageIcon, ImagePlus, MoveVertical, Palette, Save } from 'lucide-react'

import { coverY } from '@entities/formSchema'
import { CoverBand, LogoMark } from '@fields/pageChrome'

import { CoverDialog, LogoDialog } from './CoverDialog'
import { coverOverflowPx, nextCoverY } from './coverDrag'
import { DEFAULT_COVER_COLOR } from './designEdit'
import { uploadLogoPlaceholder, type FormIdSource } from './mediaUpload'
import { useBuilderStore } from './storeContext'
import { Button } from '@/components/ui/button'
import { humanError } from '../../../shared/api/errors'

// Хром страницы в РЕДАКТОРЕ: та же обложка и тот же логотип, что увидит респондент
// (общие CoverBand/LogoMark из @fields), плюс жесты автора поверх них. Ни одного
// правила ВИДА обложки здесь нет — разъехавшийся редактор это WYSIWYG, который врёт.
// Всё, что добавляет этот файл, — оверлеи с кнопками, загрузка и перетаскивание.

// Кнопка оверлея поверх картинки автора — белая кнопка кабинета (`outline`), а не
// плашка в цветах темы формы (решение владельца 2026-09-14): это служебный контрол
// редактора, и выглядит он так же, как остальной хром. Тот же вид у картинки блока
// (ImageField).
function OverlayButton({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      {children}
    </Button>
  )
}

// FormChrome — обложка и логотип на полотне редактора со всеми жестами автора.
// Рисуется ДО колонки блоков: обложка идёт во всю ширину полотна, поэтому живёт вне
// коробки с максимальной шириной, а логотип — уже внутри неё (см. SlashEditor).
export function CoverArea({ formId }: { formId: FormIdSource }) {
  const cover = useBuilderStore((s) => s.cover)
  const setCoverY = useBuilderStore((s) => s.setCoverY)

  const bandRef = useRef<HTMLDivElement>(null)
  // Режим «изменить положение» и черновик сдвига. Сдвиг ведётся в ЛОКАЛЬНОМ состоянии
  // весь режим — через сколько угодно протяжек — и уходит в стор ОДИН раз, по «Сохранить»;
  // «Отменить» черновик выбрасывает (решение владельца 2026-09-14). Запись на каждый
  // кадр перерисовывала бы всё полотно шестьдесят раз в секунду — ровно та ошибка,
  // которой выборщик цвета нагрузил TD-32, — а запись на каждое отпускание оставила бы
  // «Отменить» нечего отменять.
  const [moving, setMoving] = useState(false)
  const [draftY, setDraftY] = useState<number | null>(null)
  // overflow — ход жеста в пикселях (на сколько картинка перерастает полосу). Меряется
  // ОДИН раз, на нажатии: в середине протяжки ни размер полосы, ни размер картинки не
  // меняются, а замер на каждом кадре стоил бы принудительного пересчёта раскладки.
  const drag = useRef<{ pointerY: number; startY: number; y: number; overflow: number } | null>(
    null,
  )

  if (!cover) return null

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!moving || !cover?.imageKey) return
    const band = bandRef.current
    const img = band?.querySelector('img')
    e.currentTarget.setPointerCapture(e.pointerId)
    // Следующая протяжка продолжает черновик, а не начинает от сохранённого.
    const from = draftY ?? coverY(cover)
    drag.current = {
      pointerY: e.clientY,
      startY: from,
      y: from,
      overflow: coverOverflowPx(
        img?.naturalWidth ?? 0,
        img?.naturalHeight ?? 0,
        band?.offsetWidth ?? 0,
        band?.offsetHeight ?? 0,
      ),
    }
    setDraftY(from)
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    d.y = nextCoverY(d.startY, d.pointerY, e.clientY, d.overflow)
    setDraftY(d.y)
  }

  // Черновик на отпускании берётся из РЕФА, а не из состояния: между последним
  // pointermove и pointerup React может не успеть перерисоваться, и состояние отстанет
  // на кадр — «Сохранить» тогда сохранил бы предпоследнее положение. Отставание состояния
  // от жеста — тот же класс дефектов, что нашёлся в фазе 14 на выделении текста.
  function onPointerUp() {
    const d = drag.current
    if (!d) return
    drag.current = null
    setDraftY(d.y)
  }

  // В схему уходит сотая процента, а не целое: целый процент стоит несколько пикселей,
  // и округление до него сдвигало картинку после сохранения. Сотые — только чтобы не
  // писать в документ хвост двоичной дроби; сдвига от них меньше полупикселя. Без
  // протяжки сохранять нечего — и шага истории не появляется.
  function finishMoving() {
    if (draftY !== null) setCoverY(Math.round(draftY * 100) / 100)
    setDraftY(null)
    setMoving(false)
  }

  function cancelMoving() {
    drag.current = null
    setDraftY(null)
    setMoving(false)
  }

  return (
    <div className="group/cover relative">
      <div
        ref={bandRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // select-none и touch-none — чтобы жест не соревновался с выделением текста
        // и прокруткой страницы; нативный drag самой картинки выключен в CoverBand.
        className={moving ? 'cursor-grab touch-none select-none active:cursor-grabbing' : undefined}
      >
        {/* Общий вывод: в редакторе показывается ровно то, что увидит респондент.
            Во время жеста подставляется ЧЕРНОВИК сдвига — картинка едет за рукой,
            хотя в сторе ещё старое значение. */}
        <CoverBand cover={draftY === null ? cover : { ...cover, y: draftY }} />
      </div>

      {/* Подсказка режима положения — посередине полосы и видна весь режим, а не по
          наведению (решение владельца 2026-09-14). pointer-events-none: протяжка идёт
          сквозь неё по самой картинке. Чёрная полупрозрачная плашка задана цветом, а не
          токеном: лежит на картинке автора любого цвета, и тема кабинета её контраст
          не определяет. */}
      {moving && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
          <span className="rounded-lg bg-black/60 px-4 py-2 text-center text-sm text-white">
            Перетащите картинку, чтобы изменить её положение
          </span>
        </div>
      )}

      {/* Кнопок две (решение владельца 2026-09-14): «Положение» и «Изменить». Всё, чем
          полосу заливают и убирают — файл, ссылка, цвет, удаление, — живёт в окне
          CoverDialog, общем с строкой «Обложка» шторки оформления.

          Кнопки — в правом нижнем углу полосы (решение владельца 2026-09-14): центр
          закрывал саму картинку, а левый нижний угол занят логотипом, наезжающим на
          обложку (.rf-logo--over). */}
      <div className="pointer-events-none absolute inset-0 flex items-end justify-end p-4 opacity-0 transition-opacity focus-within:opacity-100 group-hover/cover:opacity-100">
        <div className="pointer-events-auto flex items-center gap-2">
          {moving ? (
            <>
              <OverlayButton onClick={finishMoving}>
                <Save /> Сохранить
              </OverlayButton>
              <OverlayButton onClick={cancelMoving}>Отменить</OverlayButton>
            </>
          ) : (
            <>
              {/* Двигать можно только картинку: у цвета двигать нечего, и схема
                  такой документ отвергает. */}
              {cover.imageKey && (
                <OverlayButton onClick={() => setMoving(true)}>
                  <MoveVertical /> Положение
                </OverlayButton>
              )}
              <CoverDialog formId={formId}>
                <Button type="button" variant="outline" size="sm">
                  <ImageIcon /> Изменить
                </Button>
              </CoverDialog>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// LogoArea — логотип на полотне. Стоит ВНУТРИ колонки (в отличие от обложки), поэтому
// и компонент отдельный: они соседи по смыслу, но не по DOM.
//
// Кнопок на знаке нет (решение владельца 2026-09-14): нажатие на сам логотип открывает
// окно логотипа (LogoDialog) — загрузка, ссылка, удаление.
export function LogoArea({ formId, over }: { formId: FormIdSource; over: boolean }) {
  const logo = useBuilderStore((s) => s.logo)

  if (!logo) return null

  return (
    <div className="relative w-fit">
      <LogoMark logo={logo} over={over} />
      {/* Нажимаемый слой ПОВЕРХ знака, а не кнопка-обёртка: LogoMark — блочный div с
          отступами нахлёста, и внутри <button> его раскладка разошлась бы с превью и
          рендерером. Слой скруглён ПО ЛОГОТИПУ (--rf-logo-radius): скругление задаёт
          автор, и при круглом знаке квадратная подсветка вылезала бы углами. */}
      <LogoDialog formId={formId}>
        <button
          type="button"
          aria-label="Изменить логотип"
          className="absolute inset-0 cursor-pointer rounded-[var(--rf-logo-radius)] outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </LogoDialog>
    </div>
  )
}

// AddChrome — кнопки «завести», появляющиеся над заголовком по наведению на сам
// заголовок (group/title у обёртки в SlashEditor.tsx), а не на всё полотно: иначе
// они мигали бы при каждом движении мыши по форме, а не только у заголовка.
//
// Стоят ВНЕ ПОТОКА (обёртка нулевой высоты + absolute), а не занимают место: иначе
// ритм полотна разъехался бы с превью и рендерером на высоту этой полосы. Из потока
// они заодно не могут «схлопнуться» на mousedown и съесть первый клик — тот дефект
// (TD-22) жил ровно у контрола, который место в потоке занимал.
export function AddChrome({
  formId,
  onOpenDesign,
}: {
  formId: FormIdSource
  onOpenDesign: () => void
}) {
  const cover = useBuilderStore((s) => s.cover)
  const logo = useBuilderStore((s) => s.logo)
  const setCover = useBuilderStore((s) => s.setCover)
  const setLogo = useBuilderStore((s) => s.setLogo)
  const [addingLogo, setAddingLogo] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Логотип заводится заглушкой, а не диалогом выбора файла — как обложка цветом:
  // один клик, и знак уже на месте; свою картинку ставят нажатием на него (LogoDialog).
  function addLogo() {
    if (addingLogo) return
    setError(null)
    setAddingLogo(true)
    uploadLogoPlaceholder(formId)
      .then((imageKey) => setLogo({ imageKey }))
      .catch((err: unknown) => setError(humanError(err, 'Не удалось добавить логотип')))
      .finally(() => setAddingLogo(false))
  }

  // Кластер живёт, даже когда заводить нечего: «Оформление» — не «завести», оно
  // уместно всегда, и раньше кнопки исчезали целиком при обложке с логотипом.
  return (
    <div className="relative h-0">
      {/* bottom-0 + pb вместо bottom-N: зазор до заголовка становится ПАДДИНГОМ
        коробки, а не пустым местом снаружи неё — иначе курсор, идущий от заголовка к
        кнопкам, на середине пути покидал бы group/title (там ничего нет) и наведение
        гасло раньше, чем курсор доходил.

        pb-2/sm:pb-3 — не наугад: коробка растёт вверх от заголовка внутри промежутка
        «обложка → заголовок» (SlashEditor, pt-15/sm:pt-17 = 60/68px), а этот отступ
        держит строку ТЕКСТА кнопок БЛИЗКО к заголовку — 12/16px: малая кнопка
        высотой 28 добавляет под текстом свои 4. Остаток промежутка достаётся
        обложке сверху: воздуха там заметно больше, чем до заголовка, — так и
        задумано. Меняешь верхний отступ в SlashEditor/fields.css — держи pb здесь
        заметно меньше половины, иначе перекос обратно уедет к обложке.

        -ml-2 возвращает значок первой кнопки к левому краю заголовка: у ghost-кнопки
        видимая граница — значок и текст, а её поля (8 при значке) сдвигали бы их
        вправо. Кнопки стоят без gap — поля и есть зазор. */}
      <div className="absolute bottom-0 left-0 -ml-2 flex items-center whitespace-nowrap pb-2 sm:pb-3 opacity-0 transition-opacity focus-within:opacity-100 group-hover/title:opacity-100">
        {!cover && (
          // Обложка заводится ЦВЕТОМ, а не диалогом выбора файла: один клик — и она
          // уже есть, а картинка ставится следующим жестом с той же полосы. Пустой
          // обложки-заглушки в схеме не бывает, поэтому «завести и выбрать потом»
          // выразить нечем.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setCover({ color: DEFAULT_COVER_COLOR })}
          >
            <ImageIcon /> Добавить обложку
          </Button>
        )}
        {!logo && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={addingLogo}
            onClick={addLogo}
          >
            <ImagePlus /> Добавить логотип
          </Button>
        )}
        {/* «Оформление» — тот же вход, что кнопка-палитра в шапке: шторка одна, и
            второго её состояния здесь не заводится. Стоит рядом с обложкой и
            логотипом потому, что размеры того и другого настраиваются как раз в
            ней — жест «дотянуться до вида страницы» начинается в одном месте. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={onOpenDesign}
        >
          <Palette /> Оформление
        </Button>
        {error && <span className="ml-2 text-sm text-destructive">{error}</span>}
      </div>
    </div>
  )
}
