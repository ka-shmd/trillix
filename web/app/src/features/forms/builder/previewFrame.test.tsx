// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { PreviewFrame } from './PreviewFrame'
import { createBuilderStore } from './store'

// Сторож одного корня во фрейме. Эффект монтирования прогоняется ДВАЖДЫ (StrictMode
// в dev), и узел `#preview-root`, оставленный первым прогоном, ломается не мусором в
// DOM, а видом: `FRAME_RESET` тянет ему `min-height:100%` по id, то есть каждый
// осиротевший узел даёт экран пустоты над формой. Глазами это ловится только в dev —
// прод-сборка StrictMode дважды не прогоняет.

afterEach(cleanup)

const frameDoc = (container: HTMLElement) => container.querySelector('iframe')!.contentDocument!

it('оставляет во фрейме один корень при повторном прогоне эффекта', async () => {
  const store = createBuilderStore()
  const { container } = render(
    <StrictMode>
      <PreviewFrame store={store}>
        <p>форма</p>
      </PreviewFrame>
    </StrictMode>,
  )
  // Снос корня отложен на микрозадачу — вместе с ним уезжает и узел.
  await Promise.resolve()

  expect(frameDoc(container).querySelectorAll('#preview-root')).toHaveLength(1)
})
