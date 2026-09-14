// @vitest-environment happy-dom
import { Suspense } from 'react'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { preloadCalendar } from './calendarChunk'
import { InlineCalendar } from './lazyCalendar'

afterEach(cleanup)

// Страница расписания появляется одним кадром (решение владельца 2026-09-14): календарь,
// загруженный заранее, обязан нарисоваться в ПЕРВОМ рендере, не выпадая в заглушку
// границы. Выпав, он показался бы позже полотна — ровно то, от чего уходили.
it('загруженный заранее календарь рисуется сразу, без заглушки границы', async () => {
  await preloadCalendar()

  render(
    <Suspense fallback={<p>заглушка</p>}>
      <InlineCalendar mode="single" />
    </Suspense>,
  )

  expect(screen.queryByText('заглушка')).toBeNull()
  expect(screen.getByRole('grid')).toBeTruthy()
})
