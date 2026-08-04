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
}

// Имя, под которым инструментовка живёт в окне. С префиксом, чтобы не столкнуться ни
// с чем в приложении.
const NS = '__perf'

export const instrumentSource = `(() => {
  const ns = { mutations: 0, attrMutations: 0, attrByTarget: {}, resizeObservers: 0, boundingRects: 0, frames: [], ok: {} };
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
  if (!ns) return { mutations: null, attrMutations: null, attrByTarget: null, resizeObservers: null, boundingRects: null, frames: null };
  return {
    mutations: ns.ok.mutations ? ns.mutations : null,
    attrMutations: ns.ok.mutations ? ns.attrMutations : null,
    attrByTarget: ns.ok.mutations ? ns.attrByTarget : null,
    resizeObservers: ns.ok.resizeObservers ? ns.resizeObservers : null,
    boundingRects: ns.ok.boundingRects ? ns.boundingRects : null,
    frames: ns.ok.frames ? ns.frames.slice() : null,
  };
})()`

// Обнуление перед замеряемым участком: сравнивать разницу счётчиков надёжнее, чем
// доверять тому, что до участка ничего не происходило.
export const resetCountersSource = `(() => {
  const ns = window['${NS}'];
  if (!ns) return false;
  ns.mutations = 0; ns.attrMutations = 0; ns.attrByTarget = {};
  ns.resizeObservers = 0; ns.boundingRects = 0; ns.frames.length = 0;
  return true;
})()`
