// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

import { type FormDetail } from '../../entities/form'
import { NEW_FORM_SLUG, newFormDetail, useFormEditorTarget } from './draft'

// Экран редактора обслуживает и настоящую форму, и ещё не созданный черновик, и
// маршрут у них ОДИН — компонент между ними переиспользуется. Отсюда правило «когда
// экран начинается заново», и проверяется оно здесь, а не запуском роутера.
//
// Из-за него был дефект: «+» у пространства в сайдбаре, нажатое ИЗ редактора готовой
// формы, меняло только slug — решение «это черновик», принятое один раз на
// монтировании, не пересматривалось, и экран спрашивал у сервера форму `new`. Автор
// вместо чистого полотна получал «Форма не найдена» при изменившемся адресе.

afterEach(cleanup)

const CREATED: FormDetail = { ...newFormDetail(), id: 'f1', slug: 'abcdefghij' }

type Seen = ReturnType<typeof useFormEditorTarget>

function setup(slug: string, workspaceSlug = '') {
  let seen: Seen
  function Probe({ slug, workspaceSlug }: { slug: string; workspaceSlug: string }) {
    seen = useFormEditorTarget(slug, workspaceSlug)
    return null
  }
  const view = render(<Probe slug={slug} workspaceSlug={workspaceSlug} />)
  return {
    at: () => seen,
    go: (slug: string, workspaceSlug = '') =>
      act(() => view.rerender(<Probe slug={slug} workspaceSlug={workspaceSlug} />)),
    // Создание формы: карточка из ответа POST, а следом адрес догоняет её replace'ом.
    create: () => act(() => seen.adoptCreated(CREATED)),
  }
}

describe('мишень экрана редактора', () => {
  it('«+» из редактора готовой формы открывает черновик, а не спрашивает форму `new`', () => {
    const t = setup('abcdefghij')
    expect(t.at().isDraft).toBe(false)

    t.go(NEW_FORM_SLUG)

    expect(t.at().isDraft).toBe(true)
    expect(t.at().draftDetail?.slug).toBe(NEW_FORM_SLUG)
  })

  it('создание формы не перемонтирует полотно', () => {
    const t = setup(NEW_FORM_SLUG)
    const before = t.at().canvasKey

    t.create()
    t.go(CREATED.slug)

    expect(t.at().canvasKey).toBe(before)
    expect(t.at().draftDetail?.id).toBe('f1')
  })

  it('второе «+» подряд даёт чистое полотно, а не уже заведённую форму', () => {
    const t = setup(NEW_FORM_SLUG)
    t.create()
    t.go(CREATED.slug)
    const first = t.at().canvasKey

    t.go(NEW_FORM_SLUG)

    expect(t.at().draftDetail?.id).toBe('')
    expect(t.at().canvasKey).not.toBe(first)
  })

  it('«+» у другого пространства — тоже другой черновик: slug в адресе один и тот же', () => {
    const t = setup(NEW_FORM_SLUG, '')
    const personal = t.at().canvasKey

    t.go(NEW_FORM_SLUG, 'team')

    expect(t.at().isDraft).toBe(true)
    expect(t.at().canvasKey).not.toBe(personal)
  })

  it('уход на другую форму гасит черновик — деталь приедет запросом', () => {
    const t = setup(NEW_FORM_SLUG)

    t.go('qwertyuiop')

    expect(t.at().isDraft).toBe(false)
    expect(t.at().draftDetail).toBe(null)
    expect(t.at().canvasKey).toBe('qwertyuiop')
  })
})
