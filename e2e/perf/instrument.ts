// Инструментовка страницы для замера полотна (TD-32, TD-55).
//
// Всё, что нельзя спросить у CDP, считает сама страница: сколько раз DOM был
// мутирован, сколько создано ResizeObserver'ов, сколько раз позвали
// getBoundingClientRect и какой длины оказались кадры. Скрипт ставится через
// addInitScript, то есть до загрузки приложения, — иначе патчи не увидят ни
// монтирования, ни первых наблюдателей.
//
// Правило PROCESS §4 «диагностика не должна глотать ошибки» здесь значит вот что:
// счётчик, который не смог установиться, обязан быть отличим от честного нуля.
// Поэтому каждый счётчик отдаётся ЧИСЛОМ ТОЛЬКО если патч встал; иначе поле
// приходит как null и отчёт печатает «н/д», а не 0.

export type PageCounters = {
  mutations: number | null
  attrMutations: number | null
  // Разбивка мутаций атрибутов по «тег[имя атрибута]» — из неё видно, что 390 из 400
  // записей на символ это React, переставляющий name у каждого input (TD-32).
  attrByTarget: Record<string, number> | null
  resizeObservers: number | null
  boundingRects: number | null
  frames: number[] | null
  longTasks: number[] | null
  // Задержка от нажатия на ручку до первого сдвига строки, мс. null — проба не
  // ставилась или одно из двух событий не наступило (это отдельный исход, а не ноль).
  dragStartMs: number | null
}

// Имя, под которым инструментовка живёт в окне. С префиксом, чтобы не столкнуться ни
// с чем в приложении.
const NS = '__perf'

export const instrumentSource = `(() => {
  const ns = { mutations: 0, attrMutations: 0, attrByTarget: {}, resizeObservers: 0, boundingRects: 0, frames: [], longTasks: [], dragDown: 0, dragMoved: 0, scrollReads: 0, scrollStacks: {}, ok: {} };
  window['${NS}'] = ns;

  // 1. Мутации DOM. Наблюдатель ставится на document, как только он есть, и
  //    считает всё дерево — включая атрибуты, потому что именно они и составляют
  //    основную массу записей на нажатие клавиши.
  try {
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        ns.mutations++;
        if (r.type === 'attributes') {
          ns.attrMutations++;
          const el = r.target;
          const key = (el.tagName || '?') + '[' + r.attributeName + ']';
          ns.attrByTarget[key] = (ns.attrByTarget[key] || 0) + 1;
        }
      }
    });
    const start = () => obs.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    if (document.documentElement) start();
    else document.addEventListener('readystatechange', function once() {
      if (document.documentElement) { start(); document.removeEventListener('readystatechange', once); }
    });
    ns.ok.mutations = true;
  } catch (e) { ns.ok.mutations = false; ns.mutationsError = String(e); }

  // 2. ResizeObserver: dnd-kit заводит по одному на каждый droppable при
  //    MeasuringStrategy.Always (TD-55, источник 2). Считаем конструкторы.
  try {
    const Native = window.ResizeObserver;
    if (typeof Native === 'function') {
      window.ResizeObserver = class extends Native {
        constructor(...args) { ns.resizeObservers++; super(...args); }
      };
      ns.ok.resizeObservers = true;
    } else { ns.ok.resizeObservers = false; }
  } catch (e) { ns.ok.resizeObservers = false; ns.resizeObserversError = String(e); }

  // 3. getBoundingClientRect: синхронный замер геометрии. Им меряют рамки полотна
  //    (measureUnion/measureDropLine) и стратегия замера dnd-kit; на структурной
  //    правке он же выстреливает пачкой по всем droppable'ам.
  try {
    const proto = Element.prototype;
    const native = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function () { ns.boundingRects++; return native.apply(this, arguments); };
    ns.ok.boundingRects = true;
  } catch (e) { ns.ok.boundingRects = false; ns.boundingRectsError = String(e); }

  // 3b. Длинные задачи. Кадр длиной 150 мс — это одна задача, которая не пустила
  //     браузер рисовать; хронометр кадров это видит, но не говорит, СКОЛЬКО их и
  //     сколько времени суммарно съедено. Владелец описывает симптом как «дёргано» —
  //     а дёрганость это ровно распределение длинных задач, не среднее.
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) ns.longTasks.push(e.duration);
    });
    po.observe({ entryTypes: ['longtask'] });
    ns.ok.longTasks = true;
  } catch (e) { ns.ok.longTasks = false; ns.longTasksError = String(e); }

  // 3c. Задержка старта драга: сколько проходит от нажатия на ручку до момента,
  //     когда перетаскиваемая строка ВПЕРВЫЕ сдвинулась. Это то, что владелец видит
  //     как «взялся, а блок поехал не сразу», и никакая из прежних метрик его не
  //     ловит: суммарный JS за жест одинаков и когда лаг в начале, и когда его нет.
  window['${NS}watchDrag'] = (blockId) => {
    ns.dragDown = 0; ns.dragMoved = 0;
    const row = document.querySelector('[data-block-id="' + blockId + '"]');
    if (!row) return false;
    document.addEventListener('pointerdown', () => { ns.dragDown = performance.now(); }, { capture: true, once: true });
    const obs = new MutationObserver((records) => {
      if (ns.dragMoved || !ns.dragDown) return;
      for (const r of records) {
        const v = r.target.getAttribute && r.target.getAttribute('style');
        if (v && v.indexOf('translate') >= 0) { ns.dragMoved = performance.now(); obs.disconnect(); return; }
      }
    });
    obs.observe(row, { attributes: true, attributeFilter: ['style'] });
    return true;
  };

  // 3d. ДИАГНОСТИКА (по флагу): кто читает scrollLeft/scrollTop. Чтение scroll-свойства
  //     форсирует layout, и в CPU-профиле жеста это самая дорогая функция самотайма —
  //     но профиль называет функцию, а не вызывающего. Патч геттера со снимком стека
  //     отвечает на «кто», после чего диагностика снимается.
  if (globalThis.__perfScrollStacks) {
    try {
      // Полотно прокручивается ОКНОМ, а не внутренним контейнером, поэтому
      // getScrollableAncestors у dnd-kit отдаёт [window], и смещения он берёт из
      // window.scrollX/scrollY — не из scrollLeft элемента (проверено: патч на
      // Element.prototype не перехватил ни одного чтения).
      for (const [target, prop] of [[Window.prototype, 'scrollX'], [Window.prototype, 'scrollY'], [Element.prototype, 'scrollLeft'], [Element.prototype, 'scrollTop']]) {
        const d = Object.getOwnPropertyDescriptor(target, prop);
        if (!d || !d.get) continue;
        const nativeGet = d.get;
        Object.defineProperty(target, prop, {
          configurable: true,
          get: function () {
            ns.scrollReads = (ns.scrollReads || 0) + 1;
            ns.scrollBy = ns.scrollBy || {}; ns.scrollBy[prop] = (ns.scrollBy[prop] || 0) + 1;
            if (ns.scrollReads % 500 === 0) {
              const st = (new Error().stack || '').split(String.fromCharCode(10)).slice(2, 5).join(' | ');
              ns.scrollStacks[st] = (ns.scrollStacks[st] || 0) + 1;
            }
            return nativeGet.call(this);
          },
          set: d.set,
        });
      }
      ns.ok.scrollStacks = true;
    } catch (e) { ns.ok.scrollStacks = false; ns.scrollStacksError = String(e); }
  }

  // 4. Хронометр кадров. Пишем длительности между соседними rAF; из них берётся
  //    худший кадр и p95. Цикл крутится всегда — в покое он стоит один вызов на
  //    кадр и в замеряемые числа не входит (замер снимается разницей счётчиков).
  try {
    let prev = 0;
    const tick = (t) => {
      if (prev) ns.frames.push(t - prev);
      prev = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    ns.ok.frames = true;
  } catch (e) { ns.ok.frames = false; ns.framesError = String(e); }
})()`

// Снимок счётчиков. Возвращает null у тех, чей патч не встал: честный ноль и
// несработавшая диагностика обязаны отличаться (PROCESS §4).
export const readCountersSource = `(() => {
  const ns = window['${NS}'];
  if (!ns) return { mutations: null, attrMutations: null, attrByTarget: null, resizeObservers: null, boundingRects: null, frames: null, longTasks: null, dragStartMs: null };
  return {
    mutations: ns.ok.mutations ? ns.mutations : null,
    attrMutations: ns.ok.mutations ? ns.attrMutations : null,
    attrByTarget: ns.ok.mutations ? ns.attrByTarget : null,
    resizeObservers: ns.ok.resizeObservers ? ns.resizeObservers : null,
    boundingRects: ns.ok.boundingRects ? ns.boundingRects : null,
    frames: ns.ok.frames ? ns.frames.slice() : null,
    longTasks: ns.ok.longTasks ? ns.longTasks.slice() : null,
    dragStartMs: ns.dragDown && ns.dragMoved ? ns.dragMoved - ns.dragDown : null,
  };
})()`

// Поставить пробу задержки старта драга на конкретную строку. Зовётся ПЕРЕД
// mousedown; возвращает false, если строки в DOM нет (замер тогда недостоверен, и
// вызывающий обязан упасть, а не молча получить null).
export const watchDragSource = (blockId: string) =>
  `window['${NS}watchDrag'](${JSON.stringify(blockId)})`

// Обнуление перед замеряемым участком: сравнивать разницу счётчиков надёжнее, чем
// доверять тому, что до участка ничего не происходило.
export const resetCountersSource = `(() => {
  const ns = window['${NS}'];
  if (!ns) return false;
  ns.mutations = 0; ns.attrMutations = 0; ns.attrByTarget = {};
  ns.resizeObservers = 0; ns.boundingRects = 0; ns.frames.length = 0;
  ns.longTasks.length = 0; ns.dragDown = 0; ns.dragMoved = 0;
  return true;
})()`
