import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { DEFAULT_SUBMIT_LABEL, isAnswerableType } from '@entities/formSchema'
import { type Answer } from '@fields/answer'
import { BlockField } from '@fields/BlockField'
import {
  groupBlocks,
  groupMeta,
  blockRowWidths,
  cellVars,
  groupRowWidths,
  packGroupRows,
  packRows,
  splitFormTitle,
  splitThankYou,
} from '@fields/groups'
import { customStyleSheet } from '@fields/customCss'
import { UploaderProvider } from '@fields/fileUpload'
import { designClasses, DESIGN_VAR_NAMES, designToVars } from '@fields/design'
import { planForm, stripHiddenAnswers, withVisibleOptions } from '@fields/logic'
import { MentionContext, mentionResolver } from '@fields/mention'
import { CoverBand, LogoMark, pageClass } from '@fields/pageChrome'
import { StepBar } from '@fields/stepBar'

import { type PublicForm, type SubmitOutcome, submitAnswers } from './api'
import { Badge } from '@fields/Badge'
import { applyPrefill, type EmbedOptions, type HostBridge, readPrefill } from './embed'
import {
  answersReducer,
  clearAnswers,
  loadAnswers,
  loadPage,
  saveAnswers,
  savePage,
} from './answers'
import { firstErrorPage, firstQuestionIndex } from './pages'
import { uuidv7 } from './submissionId'
import { makeUploader } from './uploads'
import { ThankYou } from './ThankYou'
import { type Errors, validateAll, validateBlock } from './validation'
import { createVisitTracker, type VisitTracker } from './visits'

// FocusReporter — обёртка блока, сообщающая «самую дальнюю точку визита» (аналитика
// воронки). Отдельным компонентом, а не инлайном внутри рендера группы: обработчик,
// который пишет ref, обязан жить в КОМПОНЕНТЕ. Внутри обычной функции, созданной во
// время рендера, линт справедливо видит доступ к ref «во время рендера»
// (react-hooks/refs) и доказать обратное не может — а вложенные функции рендера нужны,
// потому что колонка ряда стала стопкой и группы рисуются из двух мест.
//
// onFocusCapture, а не onFocus: фокус приходит на вложенный input, а не на div. Проп
// у BlockField не заводим — поля общие с превью билдера, и аналитике публичной
// страницы там не место.
function FocusReporter({
  index,
  onReach,
  children,
}: {
  index: number
  onReach: (index: number) => void
  children: ReactNode
}) {
  return <div onFocusCapture={() => onReach(index)}>{children}</div>
}

// Задержки перед повторами при обрыве сети (мс). До 3 повторов с нарастающим
// бэкоффом — DEV-PLAN фаза 5, шаг 6. Все повторы шлют один submission_id, поэтому
// сервер не создаёт дубля.
const retryBackoffMs = [400, 1200, 3000]

// submitWithRetry повторяет отправку только при сетевом исключении (fetch упал).
// Ответ сервера (в т.ч. 4xx/5xx) — это не обрыв: возвращается сразу, ретраить нечего.
async function submitWithRetry(
  slug: string,
  body: { submissionId: string; token: string; answers: Record<string, Answer>; visitId: string },
): Promise<SubmitOutcome> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await submitAnswers(slug, body)
    } catch (e) {
      if (attempt >= retryBackoffMs.length) throw e
      await new Promise((r) => setTimeout(r, retryBackoffMs[attempt]))
    }
  }
}

// Опубликованная форма как её видит и заполняет респондент. Поля — те же @fields,
// что и превью билдера, но в интерактивном режиме. Ответы в useReducer, черновик в
// sessionStorage, клиентская валидация (required/email/число/дата) по blur и на
// «Отправить», затем реальная отправка на сервер с идемпотентностью и авторетраем.
export function FormView({
  slug,
  form,
  bridge,
  embed,
}: {
  slug: string
  form: PublicForm
  bridge: HostBridge | null
  /** Параметры вставки; null — форма открыта прямой ссылкой. */
  embed: EmbedOptions | null
}) {
  // Переход после отправки исполняет сам фрейм (`data-redirect="frame"` у сниппета).
  const redirectSelf = embed?.redirectSelf ?? false
  // Предпросмотр вставки: форма живая, но следов не оставляет — ни визита, ни ответа.
  const preview = embed?.preview ?? false
  // Настройка вида вставки: заголовок формы. Выравнивание содержимого — атрибут на
  // документе (main.tsx) и правила в index.css: оно про раскладку холста, а не про
  // блоки, и в разметке ему делать нечего.
  const hideTitle = embed?.hideTitle ?? false
  // Заголовок формы — блок документа (фаза 15), но рисуется вне потока вопросов:
  // <h1> перед .rf-form, со своим ритмом. Общий разделитель на три поверхности.
  // Версии, опубликованные до фазы, блока не несут — тогда заголовок приезжает
  // полем JSON (form.title), которое сервер резолвит из колонки.
  const { title: formTitle, rest: docBlocks } = splitFormTitle(form.schema.blocks)
  // ЭКРАН ПОСЛЕ ОТПРАВКИ отрезается от документа ДО всего остального (2026-08-21): он не
  // шаг формы, и всё, что считает шаги — planForm, индикатор, переходы логики, — не
  // должно его видеть. Флаг инертен → thankYouPage null, и ниже ровно прежнее поведение.
  const { blocks, thankYou: thankYouPage } = splitThankYou(docBlocks)

  // Предзаполнение (фаза 20). Правила и причины обоих фильтров — в applyPrefill;
  // здесь только источник правды о том, какой блок вообще можно заполнить: это
  // опубликованная схема, по которой респондент сейчас отвечает.
  const [answers, dispatch] = useReducer(answersReducer, null, () =>
    applyPrefill(
      loadAnswers(slug, form.version),
      readPrefill(window.location.search),
      (blockId) => {
        const block = form.schema.blocks.find((b) => b.id === blockId)
        return block !== undefined && isAnswerableType(block.type) && block.type !== 'multi_choice'
      },
    ),
  )
  // ПЛАН ФОРМЫ (фаза 21) — что видно при текущих ответах: страницы, видимые блоки,
  // фактическая обязательность. Форма без правил даёт ровно то же, что splitPages до
  // фазы: те же страницы, те же блоки, тот же порядок.
  //
  // Считается на каждый рендер, а не в useMemo: проход по документу — единицы
  // микросекунд на форме любого разумного размера, а мемоизация по answers всё равно
  // пересчитывала бы его на каждое нажатие клавиши. Появится замер, говорящий обратное, —
  // мемоизировать здесь одну строку.
  const plan = planForm(blocks, answers)
  // Подстановка ответов (`@`): резолвер собирается тут же и по тем же доводам, что
  // план, — обход документа дешевле мемоизации, которая всё равно пересчитывалась бы на
  // каждое нажатие. Живость подстановки этим и держится: свежий резолвер на каждый
  // введённый символ.
  const mentions = mentionResolver(blocks, answers, plan)
  // Загрузчик файлов: в предпросмотре его НЕТ — поле рисуется целиком, но байтов
  // не принимает. Иначе автор, разглядывая свою форму, засорял бы бакет
  // загрузками, которые никогда не станут ответом.
  const uploader = useMemo(
    () => (preview ? null : makeUploader(slug, form.token)),
    [preview, slug, form.token],
  )
  const pages = plan.pages
  const lastPage = pages.length - 1
  const multi = pages.length > 1

  // Номер страницы зажимается по РЕАЛЬНОМУ числу страниц, и теперь этого мало иметь
  // только при загрузке: страница может исчезнуть под ногами — человек вернулся назад,
  // сменил ответ, и весь следующий шаг оказался скрыт условием. Зажим производной, как в
  // превью билдера: состояние остаётся сырым, экран всегда в существующем диапазоне.
  const [rawPage, setPage] = useState(() => loadPage(slug, form.version, pages.length))
  const page = Math.min(rawPage, Math.max(lastPage, 0))
  const [errors, setErrors] = useState<Errors>({})
  const [attempted, setAttempted] = useState(false)
  const [phase, setPhase] = useState<'editing' | 'submitting' | 'done'>('editing')
  // notice — отказ отправки, не привязанный к полю (антиспам, закрытая форма, сеть).
  const [notice, setNotice] = useState<string | null>(null)

  // Один id на всё время жизни экрана: любые повторы (авто и ручные) идут под ним.
  const submissionId = useRef<string>('')
  // Защита от setState после размонтирования во время долгого ретрая. Флаг ставится
  // в true при монтировании и в false при размонтировании — под StrictMode (dev
  // делает mount→unmount→mount) инициализации useRef(true) недостаточно: cleanup
  // первого прохода обнулил бы флаг навсегда, и код после await молча не сработал бы.
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  // ОФОРМЛЕНИЕ НАДЕВАЕТСЯ НА КОРЕНЬ ДОКУМЕНТА, а не на контейнер, как в кабинете, и
  // это не расхождение: в рендерере вся страница И ЕСТЬ форма. Фон за её пределами —
  // область оверскролла и полоса под коротким документом — красится только через
  // body, который читает --rf-canvas; повесь мы переменные на обёртку, тёмная форма
  // получила бы белые поля вокруг себя.
  //
  // Эффектом, а не в разметке, по той же причине, по какой main.tsx ставит data-embed
  // до первой отрисовки: свойство принадлежит документу, а не узлу.
  //
  // ПЕРВЫЙ КАДР — НЕ ЗДЕСЬ: в проде тот же класс и тот же стиль уже стоят на <html>,
  // их напечатал Go из снапшота (слайс 5, internal/forms/public_page.go), поэтому
  // код ниже застаёт документ уже одетым и ничего не меняет. Он остаётся нужен там,
  // где сервера в этом пути нет: dev-страница отдаётся vite-dev'ом без оболочки.
  //
  // И ПОТОМУ ЖЕ ОН СНАЧАЛА СНИМАЕТ ЧУЖОЕ. Оболочку печатает сервер из снапшота, а
  // схему клиент забирает вторым запросом — это два независимых элемента кеша с
  // разным временем жизни. Автор переключил тему и переиздал форму: респондент
  // получает старую оболочку с `rf-theme-dark` и новую, светлую схему. У новой
  // designClasses пуст, снимать нечего, и форма осталась бы тёмной до истечения
  // кеша HTML. Поэтому убирается ВСЁ, что могло быть напечатано (классы `rf-` на
  // корне рендерера ставит только оформление, а переменные известны списком).
  useEffect(() => {
    const root = document.documentElement
    const stale = Array.from(root.classList).filter((c) => c.startsWith('rf-'))
    root.classList.remove(...stale)
    for (const name of DESIGN_VAR_NAMES) root.style.removeProperty(name)

    const vars = designToVars(form.schema.design)
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
    // Классов может быть несколько (тема + контур + вид кнопки), а classList.add со
    // строкой «a b» бросает InvalidCharacterError — поэтому список, а не строка.
    const cls = designClasses(form.schema.design).split(' ').filter(Boolean)
    root.classList.add(...cls)
    return () => {
      for (const name of Object.keys(vars)) root.style.removeProperty(name)
      root.classList.remove(...cls)
    }
  }, [form.schema.design])

  useEffect(() => {
    saveAnswers(slug, form.version, answers)
  }, [slug, form.version, answers])

  useEffect(() => {
    savePage(slug, form.version, page)
  }, [slug, form.version, page])

  // Смена шага: наверх и фокус на контейнер страницы. Контейнер, а НЕ первое поле, —
  // осознанно: фокус в input на телефоне поднимает клавиатуру и уводит экран вниз, мимо
  // заголовка нового шага. Контейнер с tabIndex=-1 и aria-label даёт скринридеру тот же
  // «мы на шаге 2», а Tab дальше приводит ровно в первое поле.
  //
  // Первый рендер пропускаем: страница 0 при открытии формы — не переход, скроллить и
  // забирать фокус у только что открытой страницы нельзя.
  //
  // ВО ФРЕЙМЕ (фаза 20) прокрутка — не наша: в блочном режиме внутреннего скролла нет
  // вовсе, а хост-страницу мы двигать не вправе, поэтому просим об этом хост
  // сообщением `page` (он подтянет фрейм, только если тот ушёл выше вида). Фокус
  // ставим с preventScroll — иначе браузер сам уведёт чужую страницу к фрейму, и
  // выйдет два прыжка на один переход. `window.scrollTo` остаётся только в режиме
  // 'page': там фрейм ростом с вьюпорт и скроллится сам.
  const pageRef = useRef<HTMLDivElement | null>(null)
  const navigated = useRef(false)
  useEffect(() => {
    if (!navigated.current) return
    if (bridge === null || bridge.mode === 'page') window.scrollTo({ top: 0 })
    pageRef.current?.focus({ preventScroll: bridge !== null })
    bridge?.page(page)
  }, [page, bridge])

  // Системная кнопка «Назад» ведёт по шагам формы, а не со страницы: на телефоне ею
  // пользуются вместо экранной, и уход с заполненной формы читается как потеря данных
  // (черновик переживёт, но человек этого не знает). URL не трогаем — pushState без
  // адреса кладёт запись в историю, оставляя ссылку прежней: ссылкой делятся, и «шаг 3»
  // в ней не нужен никому. Роутера в рендерере нет и не заводим (web/CLAUDE.md).
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const state = e.state as { formPage?: unknown } | null
      const n = typeof state?.formPage === 'number' ? state.formPage : 0
      navigated.current = true
      setPage(n >= 0 && n <= lastPage ? n : 0)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [lastPage])

  // goToPage — единственная точка смены шага: и кнопки, и переброс к странице с ошибкой.
  // История пишется здесь, а не в эффекте на page: эффект сработал бы и на popstate,
  // и «назад» упирался бы в собственную запись.
  const goToPage = (next: number) => {
    if (next === page) return
    navigated.current = true
    window.history.pushState({ formPage: next }, '')
    setPage(next)
  }

  // onBackTo — возврат кликом по линии пройденного шага. Отдельно от goToPage, потому
  // что это ход НАЗАД со всеми его правилами: гасим показанные ошибки и «уже пробовали
  // отправить», как это делает кнопка «Назад». Вперёд линии не ведут (StepBar их не
  // делает кнопками), поэтому проверять здесь нечего.
  const onBackTo = (next: number) => {
    if (locked) return
    setNotice(null)
    setAttempted(false)
    goToPage(next)
  }

  const pageBlocks = pages[page] ?? []
  // Подпись и обязательность на группу (v2): подпись → aria поля, обязательность →
  // звёздочка у блока-подписи. Считаются по ВСЕМУ документу, а не по странице: группа
  // границу страницы не пересекает (regroup ведёт её через text/image, а разрыв ни то
  // ни другое), но карта на весь документ дешевле и не зависит от того, где мы сейчас.
  // Звёздочка обязательности — из ПЛАНА: условно обязательное поле обязано получать её
  // ровно тогда, когда условие сработало, иначе форма отказывает в отправке по полю,
  // ничем не помеченному.
  const groups = groupMeta(blocks, plan.required)
  const submitLabel = form.schema.submitLabel?.trim() || DEFAULT_SUBMIT_LABEL
  const locked = phase !== 'editing'

  // Визит: «открыли» на монтировании, «дошёл до вопроса» на уходе со страницы.
  // Трекер создаётся лениво в ref, а не в эффекте: под StrictMode (dev делает
  // mount→unmount→mount) эффект выполнился бы дважды и дал два визита на одно
  // открытие. Флаг started намеренно НЕ сбрасывается в cleanup — «этот визит уже
  // посчитан» переживает повторное монтирование.
  //
  // В предпросмотре трекера нет вовсе: биконы шлёт только он, поэтому «не считать
  // визит» выражается его отсутствием, а не проверкой флага в трёх местах отправки.
  // Условие ленивой инициализации остаётся ровно `=== null` (флаг живёт в правой
  // части): линт узнаёт этот паттерн по форме и на «`=== null` И что-то ещё» ругается
  // доступом к ref во время рендера.
  const visit = useRef<VisitTracker | null>(null)
  if (visit.current === null) {
    visit.current = preview
      ? null
      : createVisitTracker(slug, form.token, form.version, window.location.search)
  }
  const started = useRef(false)
  // Самая дальняя точка визита: индекс последнего блока, которого коснулись.
  // Индекс, а не id, — сравнивать «дальше/ближе» можно только по порядку; наружу
  // всё равно уезжает id блока (переживёт многостраничные формы, ADR §10).
  const furthest = useRef(-1)
  // «Самая дальняя точка визита» пишется из обработчика фокуса, а тот живёт в функции
  // рендера группы (renderGroup ниже). Обёртка useCallback обязательна: правка ref'а
  // прямо в теле такой функции — ошибка линта (react-hooks/refs), и правило право по
  // существу — читать/писать ref во время рендера нельзя, можно только в обработчике.
  const markFurthest = useCallback((index: number) => {
    if (index > furthest.current) furthest.current = index
  }, [])

  useEffect(() => {
    const tracker = visit.current
    if (tracker === null) return
    if (!started.current) {
      started.current = true
      tracker.start()
    }

    const leave = () => {
      const block = furthest.current >= 0 ? blocks[furthest.current] : undefined
      tracker.leave(block?.id ?? null)
    }
    // pagehide ловит закрытие вкладки и переход по ссылке; visibilitychange —
    // сворачивание и переключение вкладки на мобильных, где pagehide может не
    // прийти вовсе. Оба шлют свой seq, сервер берёт наибольший.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') leave()
    }
    window.addEventListener('pagehide', leave)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', leave)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [blocks])

  // ВОРОНКА (фаза 19, шаг 5). Переход на страницу — это и есть «дошёл до сюда», то
  // самое наблюдение, которого воронке не хватало с самого начала: касание поля молчит
  // про проскроллившего и передумавшего (ADR §10, SCHEMA.md — «поменяется только способ
  // наблюдения, не модель»). Ни новых полей, ни правок в Go и SQL: тот же бикон с тем же
  // last_block_id, сервер по-прежнему берёт максимальный seq.
  //
  // Шлём ТОЛЬКО когда страница дальше уже достигнутого: «Назад» дальнюю точку не
  // откатывает, иначе вернувшийся на первый шаг выглядел бы в воронке как ушедший с него.
  // Сравнение — в позициях документа, той же мерой, что у фокусной дальней точки.
  useEffect(() => {
    if (!navigated.current) return
    const index = firstQuestionIndex(blocks, pages[page] ?? [])
    // Страница без вопросов (одно вступление) сообщать нечего: у воронки шаги — вопросы.
    if (index < 0 || index <= furthest.current) return
    furthest.current = index
    visit.current?.reach(blocks[index]!.id)
  }, [page, pages, blocks])

  const setBlockError = (blockId: string, msg: string | null) =>
    setErrors((prev) => {
      if (msg === null) {
        if (!(blockId in prev)) return prev
        const next = { ...prev }
        delete next[blockId]
        return next
      }
      return { ...prev, [blockId]: msg }
    })

  const onChange = (blockId: string, value: Answer) => {
    dispatch({ type: 'set', blockId, value })
    // Уже показанную ошибку пересчитываем на лету, чтобы она гасла по мере
    // исправления; чистое поле ошибкой не «пугаем» до blur/отправки.
    if (blockId in errors) {
      const block = blocks.find((b) => b.id === blockId)
      if (block) setBlockError(blockId, validateBlock(block, value, plan.required.has(blockId)))
    }
  }

  const onBlur = (blockId: string) => {
    const block = blocks.find((b) => b.id === blockId)

    if (block)
      setBlockError(blockId, validateBlock(block, answers[blockId], plan.required.has(blockId)))
  }

  // «Далее» проверяет ТОЛЬКО текущую страницу: пугать красным вопросы, до которых
  // человек ещё не дошёл, — верный способ его потерять. Форму целиком проверит
  // «Отправить», а финальная инстанция всё равно сервер.
  const onNext = () => {
    if (locked) return
    setNotice(null)
    setAttempted(true)
    const found = validateAll(pageBlocks, answers, plan.required)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setAttempted(false)
    goToPage(Math.min(page + 1, lastPage))
  }

  const onBack = () => {
    if (locked) return
    // Назад пускаем всегда: незаполненное обязательное поле не повод запирать человека
    // на шаге. Ответы остаются в reducer'е и в черновике — вернувшись, он их увидит.
    setNotice(null)
    setAttempted(false)
    goToPage(Math.max(page - 1, 0))
  }

  const onSubmit = async () => {
    if (locked) return
    setNotice(null)
    setAttempted(true)

    // Проверяем ВИДИМОЕ, а не весь документ: скрытый условием вопрос не спрашивали, и
    // требовать его — значит запереть человека на форме без единого видимого красного
    // поля. Видимые блоки — это плоский план (страниц, на которые он не попадёт, там нет).
    const found = validateAll(pages.flat(), answers, plan.required)
    setErrors(found)
    if (Object.keys(found).length > 0) {
      // Ошибка на другой странице (сюда попадают из-за прыжка «назад» и правки, из-за
      // восстановленного черновика и из-за формы, переопубликованной под открытой
      // вкладкой): ведём на неё, иначе сообщение указывает на невидимое.
      const target = firstErrorPage(pages, found)
      if (target !== null) goToPage(target)
      return // сеть не трогаем, пока форма невалидна
    }

    // ПРЕДПРОСМОТР ОСТАНАВЛИВАЕТСЯ РОВНО ЗДЕСЬ — после валидации, до сети. Всё, что
    // делает форма, автор увидит (обязательные поля, переход к странице с ошибкой,
    // экран благодарности), а в таблице ответов не появится ничего: ответа не было.
    if (preview) {
      setPhase('done')
      return
    }

    if (submissionId.current === '') submissionId.current = uuidv7()
    setPhase('submitting')

    let outcome: SubmitOutcome
    try {
      outcome = await submitWithRetry(slug, {
        submissionId: submissionId.current,
        token: form.token,
        // Ответы на скрытые вопросы не отправляются: они остались в стейте (человек
        // переключил источник, и введённое ждёт возврата), но формой не собраны.
        // Сервер повторит вычистку сам — здесь она ради честного тела запроса.
        answers: stripHiddenAnswers(blocks, answers),
        visitId: visit.current?.id ?? '',
      })
    } catch {
      if (!active.current) return
      setPhase('editing')
      setNotice('Не удалось отправить — проверьте соединение и попробуйте ещё раз.')
      return
    }
    if (!active.current) return

    switch (outcome.status) {
      case 'ok':
        clearAnswers(slug, form.version)
        // Хост узнаёт об успехе тем же сообщением, каким пользуется онбординг внутри
        // чужого приложения: по нему оно продолжает свой сценарий (design/embed.md §5).
        bridge?.submitted(submissionId.current)
        setPhase('done')
        return
      case 'invalid': {
        // Сервер — финальная инстанция: подсвечиваем присланные им поля. И ведём на
        // страницу первой из них по той же причине, что и при своей валидации.
        setErrors(outcome.fields)
        setPhase('editing')
        setNotice('Проверьте выделенные поля.')
        const target = firstErrorPage(pages, outcome.fields)
        if (target !== null) goToPage(target)
        return
      }
      case 'closed':
        setPhase('editing')
        setNotice('Форма больше не принимает ответы.')
        return
      case 'rejected':
        setPhase('editing')
        setNotice(outcome.message)
        return
    }
  }

  // CSS автора действует на всей странице формы, включая экран «Спасибо»: это те же
  // глаза того же респондента, и форма, теряющая фирменный вид на последнем шаге,
  // выглядит как чужая страница (тот же довод, по которому туда доехала тема).
  const customCss = customStyleSheet(form.schema.design?.css)
  const authorStyle = customCss ? <style>{customCss}</style> : null

  if (phase === 'done') {
    return (
      // Подстановка ответов работает и здесь: «Спасибо, @Имя!» — первое, что автор
      // напишет на этой странице, и увидеть вместо имени сырую метку он не должен.
      <MentionContext.Provider value={mentions}>
        {authorStyle}
        <ThankYou
          blocks={thankYouPage}
          text={form.schema.thankYouText ?? ''}
          // В предпросмотре перехода нет: он увёл бы автора с экрана «Встроить» —
          // либо сам фрейм, либо, через мост, всю страницу кабинета.
          redirectUrl={preview ? '' : (form.schema.redirectUrl ?? '')}
          bridge={redirectSelf ? null : bridge}
          badge={form.showBadge}
          preview={preview}
        />
      </MentionContext.Provider>
    )
  }

  const hasFieldErrors = Object.keys(errors).length > 0

  // Хром страницы (обложка, логотип, заголовок) — ТОЛЬКО на первой (решение владельца
  // 2026-08-05, спека §2.3): дальше идут чистые вопросы. Цена решения известна и
  // записана там же — со второго шага у респондента нет заголовка формы, и контекст
  // «что я заполняю» держит автор, поставив heading первой строкой страницы.
  const chrome = page === 0
  const cover = chrome ? form.schema.cover : undefined

  return (
    // Обложка — вне .rf-page (во всю ширину), логотип — внутри (по левому краю
    // колонки). Оба из схемы ТОЙ версии, по которой респондент открыл форму.
    <UploaderProvider value={uploader}>
      <MentionContext.Provider value={mentions}>
        {/* CSS АВТОРА — текстовым узлом, а не dangerouslySetInnerHTML (инвариант 4), и
          ПОСЛЕ наших правил: в каскаде выигрывает последний при равной специфичности,
          поэтому автор перебивает вид, не трогая fields.css. Следом идёт сторож
          текста согласия (customCss.ts) — порог, а не стена, и это записано там же. */}
        {authorStyle}
        <CoverBand cover={cover} />
        <main className={pageClass(cover)}>
          {chrome && <LogoMark logo={form.schema.logo} over={Boolean(cover)} />}
          {/* Заголовок прячет настройка вставки: над блоком на чужой странице обычно
            уже стоит свой заголовок, и второй читается как дубль. Прячется только
            показ — в документе формы заголовок остаётся, поэтому og-мета, выгрузка и
            сама форма по прямой ссылке не меняются. */}
          {chrome &&
            !hideTitle &&
            (formTitle ? (
              <BlockField block={formTitle} />
            ) : (
              form.title.trim() && <h1 className="rf-title">{form.title.trim()}</h1>
            ))}
          <div
            className="rf-form"
            ref={pageRef}
            tabIndex={multi ? -1 : undefined}
            aria-label={multi ? `Шаг ${page + 1} из ${pages.length}` : undefined}
          >
            {packRows(groupBlocks(pageBlocks)).map((row) => {
              // Вопрос — обёртка .rf-group: блоки одной группы стоят тесно (14px), между
              // группами простор (28px) — единый ритм с превью и редактором (этап 13.3).
              // Вопрос с column='right' едет одним рядом .rf-row с предыдущим (фаза 13.6,
              // спека §5); обёртка ряда — только у ряда из двоих.
              const renderGroup = (group: (typeof row)[number][number]) => (
                <div key={group.id} className="rf-group">
                  {/* Второй уровень рядов (фаза 15, §6.4): подпись и поле встают бок о
                  бок той же обёрткой .rf-row, что и два вопроса. Ряд из одного
                  остаётся прямым ребёнком .rf-group. */}
                  {packGroupRows(group.blocks).map((innerRow) => {
                    const render = (block: (typeof innerRow)[number][number]) => (
                      // Индекс блока в ПОЛНОМ потоке: группировка порядок не меняет.
                      <FocusReporter
                        key={block.id}
                        index={blocks.indexOf(block)}
                        onReach={markFurthest}
                      >
                        <BlockField
                          // Скрытые условием варианты в список не попадают (фаза 21).
                          block={withVisibleOptions(block, plan)}
                          captionText={groups.get(block.groupId)?.caption}
                          captionRequired={groups.get(block.groupId)?.required}
                          value={answers[block.id]}
                          onChange={(value: Answer) => onChange(block.id, value)}
                          onBlur={() => onBlur(block.id)}
                          error={errors[block.id]}
                          disabled={locked}
                        />
                      </FocusReporter>
                    )
                    const innerWidths = blockRowWidths(innerRow)
                    return innerRow.length > 1 ? (
                      <div key={innerRow[0]![0]!.id} className="rf-row">
                        {innerRow.map((cell, i) => (
                          <div key={cell[0]!.id} className="rf-cell" style={cellVars(innerWidths, i)}>
                            {cell.map(render)}
                          </div>
                        ))}
                      </div>
                    ) : (
                      render(innerRow[0]![0]!)
                    )
                  })}
                </div>
              )
              // В колонке ряда может стоять СТОПКА вопросов (§5): при длинном блоке слева
              // справа помещается несколько коротких. Слева стопки не бывает — там всегда
              // тот, кто открыл ряд.
              const first = row[0]?.[0]
              if (!first) return null
              // Доли колонок — из документа, тем же правилом, что у превью и полотна
              // (rowWidths): не сходятся или заданы не у всех — ряд делится поровну.
              const widths = groupRowWidths(row)
              return row.length > 1 ? (
                <div key={first.id} className="rf-row">
                  {row.map((cell, i) => (
                    <div key={cell[0]!.id} className="rf-cell" style={cellVars(widths, i)}>
                      {cell.map(renderGroup)}
                    </div>
                  ))}
                </div>
              ) : (
                renderGroup(first)
              )
            })}
          </div>
          {/* Отправка — только на последней странице; на остальных её место занимает
            «Далее». Иначе форма собирала бы неполные ответы у тех, кто дошёл до
            середины: кнопка отправки посреди шагов читается как «готово». */}
          <div className="rf-nav">
            {page > 0 && (
              <button className="rf-back" type="button" onClick={onBack} disabled={locked}>
                Назад
              </button>
            )}
            {/* Действие «скрыть кнопку» обрывает обход на этой странице: идти некуда и
              отправить нельзя. Кнопки нет вовсе, а не disabled — отключённая кнопка
              обещает, что вот-вот станет доступной. Сервер это же состояние проверяет
              сам (NormalizeAnswers): спрятанная разметкой кнопка не защищает от curl. */}
            {plan.blocked && page === lastPage ? null : page < lastPage ? (
              <button
                className="rf-submit rf-next"
                type="button"
                onClick={onNext}
                disabled={locked}
              >
                Далее
              </button>
            ) : (
              <button
                className="rf-submit"
                type="button"
                onClick={() => void onSubmit()}
                disabled={phase === 'submitting'}
              >
                {phase === 'submitting' ? 'Отправка…' : submitLabel}
              </button>
            )}
          </div>
          {/* Линии шагов — ПОД кнопками, у нижнего края страницы (решение владельца
            2026-08-05). Клик по пройденной линии возвращает на тот шаг: то же, что
            «Назад», только сразу на нужный. Вперёд по ним не ходят — туда ведёт только
            «Далее» с проверкой текущей страницы. Разметка общая с превью (@fields). */}
          <StepBar pages={pages.length} page={page} onGo={onBackTo} />
          {attempted && hasFieldErrors && (
            <p className="form-note form-note-error" role="alert">
              Проверьте выделенные поля.
            </p>
          )}
          {notice && !hasFieldErrors && (
            <p className="form-note form-note-error" role="alert">
              {notice}
            </p>
          )}
          {/* Бейдж — последней строкой страницы, под линиями шагов: он про площадку,
            а не про форму, и лезть выше содержимого автора ему незачем. */}
          {form.showBadge && <Badge />}
        </main>
      </MentionContext.Provider>
    </UploaderProvider>
  )
}
