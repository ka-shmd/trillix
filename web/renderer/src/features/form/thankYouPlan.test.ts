import { describe, expect, it } from 'vitest'

import { DEFAULT_THANK_YOU_TEXT } from '@entities/formSchema'

import { planThankYou, REDIRECT_DELAY_MS } from './thankYouPlan'

// Ветки экрана «после отправки». Компонент — тонкая оболочка над planThankYou,
// поэтому решение проверяется здесь, без DOM.
describe('planThankYou', () => {
  it('ничего не задано — дефолтная благодарность, перехода нет', () => {
    expect(planThankYou('', '')).toEqual({
      message: DEFAULT_THANK_YOU_TEXT,
      target: null,
      delayMs: 0,
    })
  })

  it('только текст владельца — показываем его, перехода нет', () => {
    const plan = planThankYou('Ждём вас на встрече!', '')
    expect(plan.message).toBe('Ждём вас на встрече!')
    expect(plan.target).toBeNull()
  })

  it('только ссылка — уходим сразу: читать нечего', () => {
    const plan = planThankYou('', 'https://example.com/thanks')
    expect(plan.target).toBe('https://example.com/thanks')
    expect(plan.delayMs).toBe(0)
    expect(plan.message).toBe(DEFAULT_THANK_YOU_TEXT)
  })

  it('текст и ссылка — показываем текст, уходим с паузой', () => {
    const plan = planThankYou('Ждём вас!', 'https://example.com')
    expect(plan.message).toBe('Ждём вас!')
    expect(plan.target).toBe('https://example.com')
    expect(plan.delayMs).toBe(REDIRECT_DELAY_MS)
  })

  it('пробельный текст считается незаданным', () => {
    const plan = planThankYou('   \n  ', 'https://example.com')
    expect(plan.message).toBe(DEFAULT_THANK_YOU_TEXT)
    expect(plan.delayMs).toBe(0)
  })

  // Инвариант 4: сервер уже отверг бы такое в ValidateSchema, но рендерер не
  // доверяет содержимому схемы на месте использования — значение идёт в
  // window.location.
  it.each([
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/thanks',
    'example.com',
    'http://',
  ])('не-http(s) ссылка %s отбрасывается — перехода нет', (raw) => {
    expect(planThankYou('Спасибо!', raw).target).toBeNull()
  })
})
