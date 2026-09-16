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
    // Каждое объявление сторожа — с !important, иначе его перебьёт авторское правило
    // с более длинным селектором.
    const declarations = CONSENT_GUARD.match(/[a-z-]+:[^;}]+/g) ?? []
    expect(declarations.length).toBeGreaterThan(0)
    for (const d of declarations) expect(d).toContain('!important')
  })

  it('контейнеры согласия возвращаются к своему display, а не к умолчанию браузера', () => {
    // revert у flex-коробки дал бы блок, и галочка съехала бы с фразы у любой формы
    // со своим CSS: сторож печатается всегда, когда CSS автора непуст.
    expect(CONSENT_GUARD).toContain('.rf-consent-box{display:flex !important')
    expect(CONSENT_GUARD).toContain('.rf-consent-check{display:inline-flex !important')
  })
})
