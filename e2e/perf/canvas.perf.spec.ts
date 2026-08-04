import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type CDPSession, type Page } from '@playwright/test'
import { login, seedAccount } from '../tests/helpers/session'
import { createForm } from './form'
import { instrumentSource, readCountersSource, resetCountersSource } from './instrument'

// Замер производительности полотна редактора — оснастка пунктов TD-32 (набор текста)
// и TD-55 (перетаскивание).
//
// ЭТО НЕ ТЕСТ, а измерительный прибор: он ничего не утверждает про поведение и в
// `npm test` не попадает (свой конфиг, `npm run perf`). Живёт он в репозитории по
// одной причине: критерий приёмки пункта техдолга — «дефект воспроизведён до починки
// и не воспроизводится после, ТЕМ ЖЕ способом» (PROCESS §1.0), а первый замер
// 2026-08-03 делался разовым скриптом, который не сохранился, — и перед починкой его
// пришлось писать заново.
//
// Как пользоваться:
//   make prod-local                                    # стек обязан быть свежим
//   cd e2e && PERF_LABEL=baseline npm run perf         # замер ДО починки
//   ... правки кода, пересборка prod-local ...
//   cd e2e && PERF_LABEL=after-step-a npm run perf     # замер ПОСЛЕ
//   node perf/compare.mjs baseline after-step-a        # разница
//
// ПОЧЕМУ ПРОД-СБОРКА, а не dev: dev-сборка React несёт проверки и профилировщик,
// которых в проде нет, а vite-dev отдаёт модули по одному — цифры завышены и
// несопоставимы с тем, что видит владелец.
//
// ЧТО ЗАМЕР НЕ ДОКАЗЫВАЕТ: он снят на одной машине в headless-Chromium. Абсолютные
// числа привязаны к железу; сравнивать можно только два прогона одной оснастки на
// одной машине. Поэтому в отчёт идёт ПАРА «до/после», а не одно число.

// Размеры форм — те же три, что в первом замере: маленькая (обычная форма), средняя
// и упирающаяся в потолок MAX_BLOCKS.
const SIZES = [13, 61, 199]

// Сколько символов набирать. Двадцати хватает, чтобы усреднить дребезг, и мало,
// чтобы не упереться в автосейв посреди замера.
const TYPE_CHARS = 20
// Пауза между нажатиями. Нужна: без неё Playwright шлёт клавиши быстрее, чем React
// успевает коммитить, и часть нажатий сливается в один рендер — цена символа выйдет
// заниженной.
const TYPE_DELAY_MS = 60

// Одно перетаскивание: 60 шагов мыши примерно за 2.3 с — как в замере 2026-08-03.
const DRAG_STEPS = 60
const DRAG_STEP_MS = 35
const DRAG_DISTANCE_PX = 420

type Metrics = Record<string, number>

type Phase = {
  scriptMs: number
  layoutMs: number
  styleMs: number
  taskMs: number
  heapDeltaMb: number
  mutations: number | null
  attrMutations: number | null
  attrTop: [string, number][] | null
  boundingRects: number | null
  resizeObservers: number | null
  worstFrameMs: number | null
  p95FrameMs: number | null
}

type SizeReport = {
  blocks: number
  idle: Phase
  typing: Phase & { perChar: { scriptMs: number; heapKb: number; mutations: number | null } }
  drag: Phase & { retainedMbAfterGc: number; hot: Hot[] }
  structural: { boundingRects: number | null; scriptMs: number }
}

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics: list } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(list.map((m) => [m.name, m.value]))
}

// Куча ПОСЛЕ принудительной сборки — единственный способ отличить утечку от пилы
// аллокаций (замер 2026-08-03 показал именно пилу; проверка обязана остаться в
// оснастке, иначе вывод «не течёт» некому подтвердить).
async function heapAfterGc(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage')
  const m = await metrics(cdp)
  return (m.JSHeapUsedSize ?? 0) / 1024 / 1024
}

const mb = (bytes: number) => bytes / 1024 / 1024

// Топ функций по САМОТАЙМУ за участок. Нужен затем, чтобы порядок починки диктовали
// данные, а не догадка: первый заход по TD-32 показал, что «очевидная» причина
// (восемь колбэков) была не той, а настоящую назвал именно профиль.
type Hot = [string, number]

async function profileTop(cdp: CDPSession, limit = 8): Promise<Hot[]> {
  const { profile } = await cdp.send('Profiler.stop')
  const self = new Map<string, number>()
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  // timeDeltas[i] — время, проведённое в samples[i]. Складываем по узлу: это и есть
  // самотайм, без времени потомков.
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (const [i, id] of samples.entries()) {
    const node = byId.get(id)
    if (!node) continue
    const f = node.callFrame
    const name = `${f.functionName || '(anonymous)'}${f.url ? `@${f.url.split('/').pop()}:${f.lineNumber}:${f.columnNumber}` : ' [native]'}`
    self.set(name, (self.get(name) ?? 0) + (deltas[i] ?? 0) / 1000)
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
  return sorted[i]!
}

// Собирает разницу счётчиков и метрик за замеряемый участок.
async function phase(
  page: Page,
  cdp: CDPSession,
  before: Metrics,
  beforeHeapBytes: number,
): Promise<Phase> {
  const after = await metrics(cdp)
  const c = (await page.evaluate(readCountersSource)) as {
    mutations: number | null
    attrMutations: number | null
    attrByTarget: Record<string, number> | null
    resizeObservers: number | null
    boundingRects: number | null
    frames: number[] | null
  }
  const frames = c.frames ? [...c.frames].sort((a, b) => a - b) : null
  return {
    scriptMs: ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000,
    layoutMs: ((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1000,
    styleMs: ((after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0)) * 1000,
    taskMs: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000,
    heapDeltaMb: mb((after.JSHeapUsedSize ?? 0) - beforeHeapBytes),
    mutations: c.mutations,
    attrMutations: c.attrMutations,
    attrTop: c.attrByTarget
      ? Object.entries(c.attrByTarget)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
      : null,
    boundingRects: c.boundingRects,
    resizeObservers: c.resizeObservers,
    worstFrameMs: frames && frames.length > 0 ? frames[frames.length - 1]! : null,
    p95FrameMs: frames && frames.length > 0 ? pct(frames, 95) : null,
  }
}

// Начало замеряемого участка: обнулить счётчики страницы, снять метрики. Сборку мусора
// зовёт вызывающий там, где ему нужна чистая точка отсчёта.
async function start(page: Page, cdp: CDPSession): Promise<[Metrics, number]> {
  const ok = await page.evaluate(resetCountersSource)
  if (!ok) throw new Error('инструментовка страницы не установилась — замер недостоверен')
  const m = await metrics(cdp)
  return [m, m.JSHeapUsedSize ?? 0]
}

test('замер полотна: набор текста и перетаскивание на формах 13/61/199 блоков', async ({
  page,
}) => {
  test.setTimeout(10 * 60_000)

  await page.addInitScript(instrumentSource)
  const email = seedAccount('perf')
  await login(page, email)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('HeapProfiler.enable')
  await cdp.send('Profiler.enable')
  // Шаг выборки чаще дефолтного (1000 мкс): жест длится секунды, и на дефолте в
  // хвосте распределения остаются единицы отсчётов — по ним ничего не видно.
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })

  const report: SizeReport[] = []

  for (const size of SIZES) {
    const slug = await createForm(page, size)
    await page.goto(`/forms/${slug}/edit`)

    const captions = page.getByRole('textbox', { name: 'Заголовок вопроса' })
    await expect(captions.first()).toBeVisible()
    // Ждём, пока полотно домонтируется целиком: замер, начатый на половине строк,
    // считает не ту форму, о которой отчитывается.
    await expect(captions).toHaveCount(Math.floor(size / 2))
    await page.waitForTimeout(1500)

    // 1. ПОКОЙ. Контрольный участок: если полотно шевелится само, все прочие числа
    // ниже — сумма замеряемого действия и фонового шума, и вычесть его будет нечем.
    await heapAfterGc(cdp)
    let [m0, h0] = await start(page, cdp)
    await page.waitForTimeout(2000)
    const idle = await phase(page, cdp, m0, h0)

    // 2. НАБОР ТЕКСТА в подпись первого вопроса (TD-32).
    await captions.first().click()
    await page.waitForTimeout(300)
    await heapAfterGc(cdp)
    ;[m0, h0] = await start(page, cdp)
    await page.keyboard.type('абвгдеёжзийклмнопрст'.slice(0, TYPE_CHARS), { delay: TYPE_DELAY_MS })
    await page.waitForTimeout(300)
    const typingPhase = await phase(page, cdp, m0, h0)
    const typing = {
      ...typingPhase,
      perChar: {
        scriptMs: typingPhase.scriptMs / TYPE_CHARS,
        heapKb: (typingPhase.heapDeltaMb * 1024) / TYPE_CHARS,
        mutations: typingPhase.mutations === null ? null : typingPhase.mutations / TYPE_CHARS,
      },
    }

    // 3. СТРУКТУРНАЯ ПРАВКА: один Enter. Отдельным участком, потому что стратегия
    // замера dnd-kit работает и ВНЕ драга (TD-55, источник 2) — состав контейнеров
    // меняется, и droppableRects пересобирается целиком.
    ;[m0, h0] = await start(page, cdp)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    const structuralPhase = await phase(page, cdp, m0, h0)
    const structural = {
      boundingRects: structuralPhase.boundingRects,
      scriptMs: structuralPhase.scriptMs,
    }

    // 4. ПЕРЕТАСКИВАНИЕ строки (TD-55). Тащим ПОЛЕ середины формы, а не подпись: у
    // подписи мульти-группы грип отдаёт групповой драг (нативный отклик sortable), а
    // дорогой путь — блочный, с rAF-циклом рамок.
    const midIndex = Math.max(0, Math.floor(Math.floor(size / 2) / 2))
    const midRow = page.locator(`[data-block-id="f${midIndex}"]`)
    await expect(midRow).toBeVisible()
    await midRow.scrollIntoViewIfNeeded()
    await midRow.hover()
    const grip = midRow.getByLabel('Настройки блока')
    const box = await grip.boundingBox()
    if (!box) throw new Error('грип строки не найден — драг замерить нечем')

    await heapAfterGc(cdp)
    ;[m0, h0] = await start(page, cdp)
    await cdp.send('Profiler.start')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= DRAG_STEPS; i++) {
      await page.mouse.move(
        box.x + box.width / 2,
        box.y + box.height / 2 + (DRAG_DISTANCE_PX * i) / DRAG_STEPS,
      )
      await page.waitForTimeout(DRAG_STEP_MS)
    }
    const dragPhase = await phase(page, cdp, m0, h0)
    const hot = await profileTop(cdp)
    await page.mouse.up()
    await page.waitForTimeout(500)
    // Утечка или пила: если после сборки куча вернулась к дозамерному уровню, за жест
    // ничего не удержано.
    const retained = (await heapAfterGc(cdp)) - mb(h0)

    report.push({
      blocks: size,
      idle,
      typing,
      drag: { ...dragPhase, retainedMbAfterGc: retained, hot },
      structural,
    })

    // eslint-disable-next-line no-console
    console.log(
      `\n=== ${size} блоков ===\n` +
        `покой:        ${idle.mutations} мутаций, ${idle.heapDeltaMb.toFixed(2)} МБ за 2 с\n` +
        `набор:        ${typing.perChar.scriptMs.toFixed(1)} мс/символ, ` +
        `${typing.perChar.heapKb.toFixed(0)} КБ/символ, ` +
        `${typing.perChar.mutations?.toFixed(0) ?? 'н/д'} мутаций/символ ` +
        `(атрибутов ${typing.attrMutations ?? 'н/д'}, топ ${JSON.stringify(typing.attrTop)})\n` +
        `Enter:        ${structural.boundingRects ?? 'н/д'} getBoundingClientRect, ` +
        `${structural.scriptMs.toFixed(0)} мс\n` +
        `драг:         ${dragPhase.scriptMs.toFixed(0)} мс JS, ` +
        `${dragPhase.heapDeltaMb.toFixed(1)} МБ, ` +
        `${dragPhase.resizeObservers ?? 'н/д'} ResizeObserver, ` +
        `худший кадр ${dragPhase.worstFrameMs?.toFixed(0) ?? 'н/д'} мс, ` +
        `p95 ${dragPhase.p95FrameMs?.toFixed(0) ?? 'н/д'} мс, ` +
        `удержано после GC ${retained.toFixed(2)} МБ\n` +
        `самотайм:     ${hot.map(([n, ms]) => `${n} ${ms.toFixed(0)}мс`).join(', ')}`,
    )
  }

  const label = process.env.PERF_LABEL ?? 'run'
  const dir = join(__dirname, 'results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${label}.json`),
    JSON.stringify({ label, at: new Date().toISOString(), report }, null, 2),
  )
  // eslint-disable-next-line no-console
  console.log(`\nрезультат: perf/results/${label}.json`)
})
