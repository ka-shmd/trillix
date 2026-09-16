import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import {
  DEFAULT_NEXT_LABEL,
  DEFAULT_SUBMIT_LABEL,
  isAnswerableType,
  isMultiChoiceType,
} from '@entities/formSchema'
import { type Answer } from '@fields/answer'
import { BlockField } from '@fields/BlockField'
import {
  groupBlocks,
  groupMeta,
  cellVars,
  groupRowWidths,
  packRows,
  splitFormTitle,
  splitThankYou,
} from '@fields/groups'
import { customStyleSheet } from '@fields/customCss'
import { UploaderProvider } from '@fields/fileUpload'
import { SlotSourceProvider } from '@fields/booking'
import { designClasses, DESIGN_VAR_NAMES, designToVars } from '@fields/design'
import { planForm, stripHiddenAnswers, withVisibleOptions } from '@fields/logic'
import { AUTO_JUMP_DELAY, shouldAutoJump } from './autoJump'
import { MentionContext, mentionResolver } from '@fields/mention'
import { CoverBand, LogoMark, pageClass } from '@fields/pageChrome'
import { groupClass } from '@fields/space'
import { StepBar } from '@fields/stepBar'

import {
  type PublicForm,
  type SubmitBody,
  type SubmitOutcome,
  savePartial,
  savePartialOnLeave,
  submitAnswers,
} from './api'
import { ConsentCheck } from './ConsentCheck'
import { Badge } from '@fields/Badge'
import { applyPrefill, type EmbedOptions, type HostBridge, readPrefill } from './embed'
import {
  answersReducer,
  clearAnswers,
  loadAnswers,
  loadPage,
  loadSubmissionId,
  saveAnswers,
  savePage,
  saveSubmissionId,
} from './answers'
import {
  browserHost,
  GOAL_OPEN,
  GOAL_START,
  GOAL_SUBMIT,
  goalSink,
  type GoalSink,
} from './metrika'
import { firstErrorPage, firstQuestionIndex } from './pages'
import { makeSlotSource } from './slots'
import { uuidv7 } from './submissionId'
import { makeUploader } from './uploads'
import { holdUntilAccepted, type FormToken } from './formToken'
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

// Пауза перед автосохранением черновика (мс). Сохраняем не на каждый символ:
// форма из двадцати полей иначе слала бы сотни запросов на одно заполнение.
const partialSaveDelayMs = 3000

// Задержки перед повторами при обрыве сети (мс). До 3 повторов с нарастающим
// бэкоффом — DEV-PLAN фаза 5, шаг 6. Все повторы шлют один submission_id, поэтому
// сервер не создаёт дубля.
const retryBackoffMs = [400, 1200, 3000]

// submitWithRetry повторяет отправку только при сетевом исключении (fetch упал).
// Ответ сервера (в т.ч. 4xx/5xx) — это не обрыв: возвращается сразу, ретраить нечего.
async function submitWithRetry(
  slug: string,
  body: SubmitBody,
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
  token,
  bridge,
  embed,
}: {
  slug: string
  form: PublicForm
  /**
   * Подписанное время выдачи (ADR §10). null — предпросмотр автора: сети в этом
   * режиме нет вовсе, поэтому отсутствие токена и есть признак «не отправляем».
   */
  token: FormToken | null
  bridge: HostBridge | null
  /** Параметры вставки; null — форма открыта прямой ссылкой. */
  embed: EmbedOptions | null
}) {
  // Переход после отправки исполняет сам фрейм (`data-redirect="frame"` у сниппета).
  const redirectSelf = embed?.redirectSelf ?? false
  // Предпросмотр вставки: форма живая, но следов не оставляет — ни визита, ни ответа.
  const preview = embed?.preview ?? false
  // Значение токена отдельной переменной: оно уезжает в зависимости эффекта черновика,
  // а объект FormToken пересоздаётся вместе с состоянием загрузчика.
  const tokenValue = token?.value ?? ''
  // Настройка вида вставки: заголовок формы. Выравнивание содержимого — атрибут на
  // документе (main.tsx) и правила в index.css: оно про раскладку холста, а не про
  // блоки, и в разметке ему делать нечего.
  const hideTitle = embed?.hideTitle ?? false
  const selfScroll = embed?.selfScroll ?? false
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
      loadAnswers(slug, form.version, form.saveLocally),
      readPrefill(window.location.search),
      (blockId) => {
        const block = form.schema.blocks.find((b) => b.id === blockId)
        return block !== undefined && isAnswerableType(block.type) && !isMultiChoiceType(block.type)
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
  const uploader = useMemo(() => (token === null ? null : makeUploader(slug, token)), [slug, token])
  // Один id на всё время жизни экрана: любые повторы (авто и ручные) идут под ним.
  //
  // Рождается ПРИ МОНТИРОВАНИИ, а не при первой отправке (фаза 27): тем же id клиент
  // держит бронь времени (bookings.client_id), а бронь берётся задолго до кнопки
  // «Отправить». Ленивое рождение в ref'е к тому же читалось на рендере — то есть
  // ровно там, где рефы читать нельзя.
  //
  // ⚠ И ПЕРЕЖИВАЕТ F5 ВМЕСТЕ С ЧЕРНОВИКОМ: черновик возвращает выбранное время, а
  // новый id сделал бы человека чужим собственной броне. Чистится вместе с черновиком
  // после успешной отправки — второй ответ под тем же id сервер считает повтором.
  const [submissionId] = useState(() => {
    const saved = loadSubmissionId(slug, form.version, form.saveLocally)
    if (saved !== null) return saved
    const fresh = uuidv7()
    saveSubmissionId(slug, form.version, fresh, form.saveLocally)
    return fresh
  })
  // Источник свободного времени: нет расписания у формы — нет и живого выбора, вопрос
  // о записи рисуется плашкой. В предпросмотре его тоже нет (token === null): холд из
  // предпросмотра занял бы настоящее время у настоящих клиентов.
  const slotSource = useMemo(
    () =>
      token === null || form.booking === null
        ? null
        : makeSlotSource(slug, form.booking, submissionId),
    [slug, token, form.booking, submissionId],
  )
  const pages = plan.pages
  const lastPage = pages.length - 1
  const multi = pages.length > 1

  // Номер страницы зажимается по РЕАЛЬНОМУ числу страниц, и теперь этого мало иметь
  // только при загрузке: страница может исчезнуть под ногами — человек вернулся назад,
  // сменил ответ, и весь следующий шаг оказался скрыт условием. Зажим производной, как в
  // превью билдера: состояние остаётся сырым, экран всегда в существующем диапазоне.
  const [rawPage, setPage] = useState(() =>
    loadPage(slug, form.version, pages.length, form.saveLocally),
  )
  const page = Math.min(rawPage, Math.max(lastPage, 0))
  const [errors, setErrors] = useState<Errors>({})
  const [attempted, setAttempted] = useState(false)
  const [phase, setPhase] = useState<'editing' | 'submitting' | 'done'>('editing')
  // notice — отказ отправки, не привязанный к полю (антиспам, закрытая форма, сеть).
  const [notice, setNotice] = useState<string | null>(null)
  // Галочка согласия (0069). Не в черновике: после перезагрузки согласие даётся заново,
  // отметкой человека, а не восстановленным состоянием.
  const [consentChecked, setConsentChecked] = useState(false)
  const [consentError, setConsentError] = useState(false)

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

  // Куда сохранять черновик, решает автор формы (`saveLocally`): sessionStorage —
  // до закрытия вкладки, localStorage — «вернуться завтра». Ответы не покидают
  // браузер респондента ни в том, ни в другом случае.
  useEffect(() => {
    saveAnswers(slug, form.version, answers, form.saveLocally)
  }, [slug, form.version, answers, form.saveLocally])

  useEffect(() => {
    savePage(slug, form.version, page, form.saveLocally)
  }, [slug, form.version, page, form.saveLocally])

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
  // 'page': там фрейм ростом с вьюпорт и скроллится сам — и в панели виджета, где
  // фрейм тоже сам себе скролл-контейнер (`scroll=frame`): просить хост двигать то,
  // что лежит внутри нас, бессмысленно, а новый шаг начинается с середины прошлого.
  const pageRef = useRef<HTMLDivElement | null>(null)
  const navigated = useRef(false)
  useEffect(() => {
    if (!navigated.current) return
    if (bridge === null || bridge.mode === 'page' || selfScroll) window.scrollTo({ top: 0 })
    pageRef.current?.focus({ preventScroll: bridge !== null })
    bridge?.page(page)
  }, [page, bridge, selfScroll])

  // ИСТОРИИ ШАГОВ НЕТ, И ПРИ ВКЛЮЧЁННОМ ХОДЕ НАЗАД ТОЖЕ (решение владельца 2026-09-07):
  // переход не пишет запись через pushState, слушателя popstate нет, и системная «Назад»
  // уводит СО СТРАНИЦЫ, как на любой одностраничной форме. Настройка `allowBack` (0055)
  // открывает РОВНО ДВА пути назад — кнопку и клик по линии пройденного шага, — а третьим,
  // историей, форма не распоряжается: во фрейме вставки записи уходят в общую историю, и
  // «Назад» чужой страницы начала бы листать наши шаги вместо ухода с неё. Цена названа
  // вслух и осталась прежней: на телефоне «Назад» уводит с заполненной формы одним
  // нажатием (черновик её переживёт, но человек этого не знает).
  //
  // Автопереход назначается СОСТОЯНИЕМ, а таймер живёт в эффекте: так уборка
  // достаётся даром — новый ответ (человек передумал, пока форма ждала) и уход с
  // экрана снимают предыдущий таймер сами, без ручного clearTimeout в трёх местах.
  const [jumpTo, setJumpTo] = useState<number | null>(null)
  useEffect(() => {
    if (jumpTo === null) return
    const timer = setTimeout(() => {
      navigated.current = true
      setPage(jumpTo)
      setJumpTo(null)
    }, AUTO_JUMP_DELAY)
    return () => clearTimeout(timer)
  }, [jumpTo])

  // goToPage — единственная точка смены шага: «Далее», возврат назад и переброс к
  // странице с ошибкой при отправке.
  const goToPage = (next: number) => {
    if (next === page) return
    navigated.current = true
    setPage(next)
  }

  // ХОД НАЗАД — за настройкой автора (`allowBack`, живая колонка 0055). Выключена —
  // назад не ведёт ничто: ни кнопки нет, ни линии индикатора не кнопки (StepBar без
  // `onGo`). Тумблер живой, поэтому решение принимается на рендере, а не при загрузке.
  const allowBack = form.allowBack && page > 0
  // goBack — возврат кликом по кнопке или по линии пройденного шага. Отдельно от
  // goToPage, потому что у хода назад свои правила: пускаем ВСЕГДА, незаполненное
  // обязательное поле не повод запирать человека на шаге (ответы остаются в reducer'е
  // и в черновике — вернувшись, он их увидит), и гасим «уже пробовали отправить», чтобы
  // сводка ошибок не встречала его на странице, которую он только что прошёл.
  const goBack = (next: number) => {
    if (locked || !form.allowBack) return
    setNotice(null)
    setAttempted(false)
    goToPage(Math.max(Math.min(next, page - 1), 0))
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
  // Текст «Далее» у КАЖДОЙ страницы свой (settings.nextLabel закрывающего разрыва):
  // обход кладёт его в план рядом со страницами, здесь остаётся дефолт на пустое.
  const nextLabel = plan.nextLabels[page]?.trim() || DEFAULT_NEXT_LABEL
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
    visit.current =
      token === null
        ? null
        : createVisitTracker(slug, token.value, form.version, window.location.search)
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
  // Цели Метрики автора (фаза 29): null — счётчика нет (не подключён, тариф, предпросмотр,
  // фрейм). Заводится в эффекте визита ниже, рядом с биконом «открыли».
  const goals = useRef<GoalSink | null>(null)
  const markFurthest = useCallback((index: number) => {
    // «Начал» — первое касание поля; повтор модуль Метрики гасит сам.
    goals.current?.reach(GOAL_START)
    if (index > furthest.current) furthest.current = index
  }, [])

  useEffect(() => {
    const tracker = visit.current
    if (tracker === null) return
    if (!started.current) {
      started.current = true
      tracker.start()
      // Цели Метрики заводятся там же, где визит: «открыл» у обоих — одно событие.
      // Трекера нет в предпросмотре, поэтому и сюда он не доходит; preview передан ради
      // явного правила в goalSink. Во фрейме цели уходят хосту через мост.
      goals.current = goalSink(
        form.metrika,
        { preview: token === null, framed: window.parent !== window, bridge },
        browserHost(),
      )
      goals.current?.reach(GOAL_OPEN)
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
  }, [blocks, bridge, form.metrika, token])

  // ЧЕРНОВИК (спека design/analytics-tally.md §10). Сохраняем набранное, пока
  // человек печатает, — но только если СЕРВЕР разрешил: `collectPartial` это тумблер
  // автора плюс разрешение тарифа, и клиенту тут решать нечего. В предпросмотре
  // билдера сбора нет по той же причине, что и визитов, — трекера там нет вовсе.
  //
  // Дебаунс, а не сохранение на каждый символ: иначе форма из двадцати полей
  // отправляла бы сотни запросов на одно заполнение. Последнее сохранение уходит на
  // уходе со страницы биконом — он переживает закрытие вкладки, где fetch отменяется.
  //
  // ⚠ СОБИРАЕМ, ТОЛЬКО ПОКА ФОРМА ЗАПОЛНЯЕТСЯ (`phase === 'editing'`). Отправка удаляет
  // черновик визита на сервере, и любое автосохранение после неё создаёт его заново —
  // строку, которой в «Незавершённых» взяться неоткуда, с содержимым уже отправленного
  // ответа.
  // Само по себе нажатие «Отправить» таймер не гасит: эффект пересобирается на КАЖДЫЙ
  // рендер (`blocks` — новый массив после splitFormTitle/splitThankYou), поэтому
  // рендеры отправки заводили бы очередной трёхсекундный таймер, который срабатывал уже
  // на экране «Спасибо». Уходом из 'editing' cleanup снимает и таймер, и бикон; отказ
  // сервера возвращает фазу — вместе с ней возвращается и сбор.
  const collectPartial = form.collectPartial && token !== null

  useEffect(() => {
    const tracker = visit.current
    if (!collectPartial || tracker === null || phase !== 'editing') return

    const body = () => ({
      visit_id: tracker.id,
      token: tokenValue,
      version: form.version,
      answers,
      last_block_id: furthest.current >= 0 ? (blocks[furthest.current]?.id ?? null) : null,
    })

    // Эффект перезапускается на каждой правке ответов, поэтому и таймер, и
    // обработчик ухода всегда видят свежее состояние — ref для этого не нужен
    // (и запрещён: писать его во время рендера нельзя).
    const timer = setTimeout(() => savePartial(slug, body()), partialSaveDelayMs)
    const onLeave = () => savePartialOnLeave(slug, body())
    window.addEventListener('pagehide', onLeave)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pagehide', onLeave)
    }
  }, [answers, blocks, collectPartial, phase, tokenValue, form.version, slug])

  // ВОРОНКА (фаза 19, шаг 5). Переход на страницу — это и есть «дошёл до сюда», то
  // самое наблюдение, которого воронке не хватало с самого начала: касание поля молчит
  // про проскроллившего и передумавшего (ADR §10, SCHEMA.md — «поменяется только способ
  // наблюдения, не модель»). Ни новых полей, ни правок в Go и SQL: тот же бикон с тем же
  // last_block_id, сервер по-прежнему берёт максимальный seq.
  //
  // Шлём ТОЛЬКО когда страница дальше уже достигнутого: дальняя точка не откатывается.
  // Без этой проверки воронка считала бы уходом с дальнего шага и переброс к странице с
  // ошибкой при отправке, и ход назад по кнопке или линии шага (`allowBack`, 0055) — в
  // обоих случаях человек НЕ ушёл с формы. Возврат в воронке не виден вовсе, и это то
  // же самое правило, что было до появления настройки, а не поблажка для неё.
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
    // Автопереход (0044): условия и довод — в autoJump.ts. ЧЕРЕЗ ПАУЗУ, а не сразу:
    // страница, исчезающая в тот же миг, читается как сбой — человек не успевает
    // увидеть, что его выбор принят. Пауза короткая, ждать её никто не будет.
    const changed = blocks.find((b) => b.id === blockId)
    if (form.autoJump && page < lastPage && changed && shouldAutoJump(pageBlocks, changed, value)) {
      setJumpTo(page + 1)
    }
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

  const onSubmit = async () => {
    if (locked) return
    setNotice(null)
    setAttempted(true)

    // Проверяем ВИДИМОЕ, а не весь документ: скрытый условием вопрос не спрашивали, и
    // требовать его — значит запереть человека на форме без единого видимого красного
    // поля. Видимые блоки — это плоский план (страниц, на которые он не попадёт, там нет).
    const found = validateAll(pages.flat(), answers, plan.required)
    setErrors(found)
    // Без галочки ответа нет — ни в предпросмотре, ни на сети: сервер отказал бы тем же.
    const consentMissing = form.consentRevision !== null && !consentChecked
    setConsentError(consentMissing)
    if (Object.keys(found).length > 0) {
      // Ошибка на другой странице (сюда попадают из-за прыжка «назад» и правки, из-за
      // восстановленного черновика и из-за формы, переопубликованной под открытой
      // вкладкой): ведём на неё, иначе сообщение указывает на невидимое.
      const target = firstErrorPage(pages, found)
      if (target !== null) goToPage(target)
      return // сеть не трогаем, пока форма невалидна
    }
    if (consentMissing) return

    // ПРЕДПРОСМОТР ОСТАНАВЛИВАЕТСЯ РОВНО ЗДЕСЬ — после валидации, до сети. Всё, что
    // делает форма, автор увидит (обязательные поля, переход к странице с ошибкой,
    // экран благодарности), а в таблице ответов не появится ничего: ответа не было.
    //
    // Условие — отсутствие токена, а не флаг предпросмотра: токена нет ровно в этом
    // режиме, и проверка «нечем разговаривать с сервером» вдобавок доказывает
    // типу, что ниже он есть.
    if (token === null) {
      setPhase('done')
      return
    }

    setPhase('submitting')

    let outcome: SubmitOutcome
    try {
      // Додержка перед сетью, а не отказ: сервер не принимает ответ моложе трёх
      // секунд, и платить за этот барьер отказом должен скрипт, а не человек,
      // заполнивший короткую форму быстро (ADR §10). Ждём уже в состоянии
      // 'submitting' — кнопка занята, отдельного экрана ожидания не нужно.
      await holdUntilAccepted(token)
      outcome = await submitWithRetry(slug, {
        submissionId,
        token: token.value,
        // Ответы на скрытые вопросы не отправляются: они остались в стейте (человек
        // переключил источник, и введённое ждёт возврата), но формой не собраны.
        // Сервер повторит вычистку сам — здесь она ради честного тела запроса.
        answers: stripHiddenAnswers(blocks, answers),
        visitId: visit.current?.id ?? '',
        consentRevision: form.consentRevision !== null && consentChecked ? form.consentRevision : '',
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
        bridge?.submitted(submissionId)
        goals.current?.reach(GOAL_SUBMIT)
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
      <SlotSourceProvider value={slotSource}>
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
              // Вопрос — обёртка .rf-group: и внутри группы, и между группами шаг один,
              // 12px — единый ритм с превью и редактором (этап 13.3, число сведено к
              // одному 2026-08-22). Ступень воздуха ПЕРЕД вопросом добавляет тот же
              // groupClass по типу первого блока (@fields/space) — заголовок раздела
              // отбивается сильнее вопроса.
              // Вопрос с column='right' едет одним рядом .rf-row с предыдущим (фаза 13.6,
              // спека §5); обёртка ряда — только у ряда из двоих.
              const renderGroup = (group: (typeof row)[number][number]) => (
                <div key={group.id} className={groupClass(group.blocks)}>
                  {group.blocks.map((block) => (
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
                  ))}
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
            {/* Кнопка лежит в своей коробке ряда: рядом с ней стоит бейдж площадки, и
              выравнивание кнопки задаётся внутри коробки, а не всем рядом (fields.css,
              .rf-nav-main). Коробка рисуется и без бейджа — ряд из одной кнопки
              выглядит так же, как до неё. */}
            <div className="rf-nav-main">
              {/* «Назад» — слева от главной кнопки шага и в той же коробке: они читаются
                парой, и настройка положения кнопки (--rf-submit-justify) обязана двигать
                обе разом. На первой странице её нет вовсе — идти назад некуда. */}
              {allowBack && (
                <button
                  className="rf-back"
                  type="button"
                  onClick={() => goBack(page - 1)}
                  disabled={locked}
                >
                  Назад
                </button>
              )}
              {/* Действие «скрыть кнопку» обрывает обход на этой странице: идти некуда и
                отправить нельзя. Кнопки нет вовсе, а не disabled — отключённая кнопка
                обещает, что вот-вот станет доступной. Сервер это же состояние проверяет
                сам (NormalizeAnswers): спрятанная разметкой кнопка не защищает от curl.

                ⚠ МИНА: при включённом ходе назад «Назад» остаётся ЕДИНСТВЕННЫМ контролом
                строки на такой странице — уйти с тупика надо чем-то. */}
              {plan.blocked && page === lastPage ? null : page < lastPage ? (
                <button
                  className="rf-submit rf-next"
                  type="button"
                  onClick={onNext}
                  disabled={locked}
                >
                  {nextLabel}
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
            {/* Бейдж — в одной строке с кнопкой, у противоположного края (решение
              владельца 2026-08-28). Кнопка во всю ширину занимает строку целиком, и
              бейдж переносится под неё — переносом ряда, а не своей веткой. */}
            {form.showBadge && <Badge />}
          </div>
          {/* Согласие — под кнопкой отправки и только там, где она есть: на промежуточных
            шагах отправлять нечего, а на тупике (кнопку скрыла логика) — нельзя. */}
          {form.consentRevision !== null && page === lastPage && !plan.blocked && (
            <ConsentCheck
              slug={slug}
              revision={form.consentRevision}
              version={form.version}
              checked={consentChecked}
              onChange={(checked) => {
                setConsentChecked(checked)
                if (checked) setConsentError(false)
              }}
              error={consentError}
              disabled={locked}
            />
          )}
          {/* Линии шагов — ПОД кнопками, у нижнего края страницы (решение владельца
            2026-08-05). Разметка общая с превью (@fields).

            ДВА НЕЗАВИСИМЫХ ТУМБЛЕРА автора, и путать их нельзя: `progress` решает, есть
            ли индикатор вообще, `allowBack` — кнопки его пройденные линии или чистый
            счётчик. Ход назад при снятой шкале остаётся кнопкой «Назад»: нажимать
            нечего, но идти есть куда. На одностраничной форме индикатора нет при любых
            значениях — счётчик из одной линии сам себя прячет. */}
          {form.progress && (
            <StepBar pages={pages.length} page={page} onGo={form.allowBack ? goBack : undefined} />
          )}
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
          {/* Предупреждение о сохранении набранного. Показывается РОВНО когда сбор
            включён: и то и другое следует из одного серверного флага, поэтому
            собирать молча продукт не может даже по ошибке (решение владельца
            2026-08-24, спека §10.3). */}
          {collectPartial && (
            <p className="form-note">Форма сохраняет введённое, даже если вы её не отправите.</p>
          )}
        </main>
      </MentionContext.Provider>
      </SlotSourceProvider>
    </UploaderProvider>
  )
}
