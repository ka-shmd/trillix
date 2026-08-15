// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { PreviewOverlay } from './PreviewOverlay'
import { createBuilderStore } from './store'

// Сторож связки «атрибут → CSS». Полноэкранный просмотр снимает с `html`
// зарезервированный жёлоб полосы прокрутки (`html[data-preview-open]` в index.css),
// иначе рядом с полосой формы стоит вторая, пустая. Связка держится на одном имени в
// двух файлах и рвётся молча — увидеть разрыв можно только глазами и только в
// открытом просмотре.

afterEach(cleanup)

const gutterOff = () => document.documentElement.hasAttribute('data-preview-open')

it('снимает жёлоб полосы прокрутки на время просмотра и возвращает при закрытии', () => {
  const store = createBuilderStore()
  const overlay = (open: boolean) => (
    <PreviewOverlay
      open={open}
      onOpenChange={() => {}}
      store={store}
      title="Анкета"
      canRemoveBadge={false}
    />
  )

  const { rerender } = render(overlay(false))
  expect(gutterOff()).toBe(false)

  rerender(overlay(true))
  expect(gutterOff()).toBe(true)

  rerender(overlay(false))
  expect(gutterOff()).toBe(false)
})
