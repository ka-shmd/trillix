import { CONSENT_GUARD, customStyleSheet } from '@fields/customCss'
import { describe, expect, it } from 'vitest'

// Содержимое <style> формы: CSS автора, следом сторож текста согласия. Порядок —
// не украшение: в каскаде при равной специфичности выигрывает последний, поэтому
// сторож обязан идти ПОСЛЕ, а не до.
describe('customStyleSheet', () => {
  it('без CSS автора не печатает ничего — даже сторожа', () => {
    // Пустой <style> с одним сторожем бессмыслен: прятать согласие нечем.
    expect(customStyleSheet(undefined)).toBe('')
    expect(customStyleSheet('')).toBe('')
    expect(customStyleSheet('   \n ')).toBe('')
  })

  it('сторож идёт после авторского CSS', () => {
    const out = customStyleSheet('.rf-page { padding: 0 }')
    expect(out.indexOf('.rf-page')).toBeLessThan(out.indexOf(CONSENT_GUARD))
    expect(out.endsWith(CONSENT_GUARD)).toBe(true)
  })

  it('сторож снимает четыре самых дешёвых способа спрятать согласие', () => {
    // Список сознательно короткий (порог, а не стена — см. customCss.ts), но эти
    // четыре обязаны быть: именно ими прячут текст в один приём.
    for (const prop of ['display', 'visibility', 'opacity', 'font-size']) {
      expect(CONSENT_GUARD).toContain(`${prop}:`)
    }
    expect(CONSENT_GUARD.match(/!important/g)?.length).toBe(4)
  })
})
