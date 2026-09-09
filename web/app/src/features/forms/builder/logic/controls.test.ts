import { describe, expect, it } from 'vitest'

import conditionEditorSrc from './ConditionEditor.tsx?raw'
import logicBlockEditorSrc from './LogicBlockEditor.tsx?raw'
import { FILL } from './controls'

// Сторож ВЫСОТЫ контролов блока условия. Проверить её computed-стилем нечем: Tailwind в
// vitest не собирается, и класс на элементе про итоговый размер ничего не говорит.
// Поэтому проверяется то, что проверить можно, — что каждый селект блока берёт общий
// набор классов, в котором высота задана ТЕМ ЖЕ вариантом, каким её задаёт shadcn.
//
// Почему сторож вообще нужен: `SelectTrigger` объявляет высоту как `data-[size=sm]:h-8`,
// и плоский `h-7` рядом её НЕ перебивает — ключи разные, tailwind-merge их не сливает, а
// в собранном CSS селектор с атрибутом специфичнее. Строка условия из-за этого стояла
// 32px против 28px у поля значения, и увидел это только владелец глазами.
//
// Исходники читаются через `?raw` — тем же способом, каким Go-паритет читает TypeScript:
// проверяется не поведение, а то, что правило соблюдено во всех местах разом.

// Класс-выражение у триггера: `className={SOURCE}`, `className={`… ${FILL}`}` и т.п.
const triggerClasses = (src: string): string[] =>
  [...src.matchAll(/<SelectTrigger[^>]*className=\{([^}]*(?:\}[^>]*)*?)\}/g)].map((m) => m[1]!)

describe('высота контролов блока условия', () => {
  it('общий набор классов задаёт высоту тем же вариантом, что shadcn', () => {
    expect(FILL).toContain('data-[size=sm]:h-7')
  })

  const files: [string, string][] = [
    ['ConditionEditor.tsx', conditionEditorSrc],
    ['LogicBlockEditor.tsx', logicBlockEditorSrc],
  ]

  for (const [name, src] of files) {
    it(`каждый селект в ${name} берёт высоту из общего набора`, () => {
      const found = triggerClasses(src)
      expect(found.length).toBeGreaterThan(0)
      for (const cls of found) {
        // Либо через общие константы (все они собраны из FILL), либо своим вариантом —
        // как у связки «все/любое», которая гасит высоту до `h-auto`.
        const shared = /FILL|SOURCE|OPERATOR|CONTROL|CONTROL_GLYPH/.test(cls)
        expect(shared || cls.includes('data-[size=sm]:')).toBe(true)
      }
    })
  }
})
