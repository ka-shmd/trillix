// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { newFormDetail } from './draft'
import { LinkPreviewCard } from './LinkPreviewCard'
import {
  DEFAULT_FORM_TITLE,
  EMPTY_LINK_PREVIEW,
  FALLBACK_FORM_TITLE,
  LINK_PREVIEW_DESCRIPTION,
  LINK_PREVIEW_SITE_NAME,
  type FormDetail,
} from '../../entities/form'

afterEach(cleanup)

// Карточка зеркалит подстановку с бэка (internal/forms/public_page.go, getHTML):
// поверх дефолтов ложатся непустые поля своей карточки. Разъехавшись с сервером, она
// перестаёт быть предпросмотром и становится картинкой — врущей ровно там, где
// проверить её глазами невозможно (карточку рисует чужой мессенджер).
function formTitled(title: string): FormDetail {
  return { ...newFormDetail(), title }
}

describe('LinkPreviewCard', () => {
  it('без своей карточки показывает дефолты: имя сервиса, заголовок формы, слоган', () => {
    render(<LinkPreviewCard form={formTitled('Опрос читателей')} preview={null} />)

    expect(screen.getByText(LINK_PREVIEW_SITE_NAME)).toBeTruthy()
    expect(screen.getByText('Опрос читателей')).toBeTruthy()
    expect(screen.getByText(LINK_PREVIEW_DESCRIPTION)).toBeTruthy()
  })

  it('заполненные поля карточки перебивают дефолты', () => {
    render(
      <LinkPreviewCard
        form={formTitled('Опрос читателей')}
        preview={{
          ...EMPTY_LINK_PREVIEW,
          siteName: 'Журнал «Кот»',
          title: 'Февральский номер',
          description: 'Три минуты, семь вопросов.',
        }}
      />,
    )

    expect(screen.getByText('Журнал «Кот»')).toBeTruthy()
    expect(screen.getByText('Февральский номер')).toBeTruthy()
    expect(screen.getByText('Три минуты, семь вопросов.')).toBeTruthy()
    expect(screen.queryByText('Опрос читателей')).toBeNull()
    expect(screen.queryByText(LINK_PREVIEW_DESCRIPTION)).toBeNull()
  })

  it('пустое поле карточки оставляет дефолт, а не пустоту', () => {
    render(
      <LinkPreviewCard
        form={formTitled('Опрос читателей')}
        preview={{ ...EMPTY_LINK_PREVIEW, title: 'Февральский номер' }}
      />,
    )

    expect(screen.getByText('Февральский номер')).toBeTruthy()
    expect(screen.getByText(LINK_PREVIEW_SITE_NAME)).toBeTruthy()
    expect(screen.getByText(LINK_PREVIEW_DESCRIPTION)).toBeTruthy()
  })

  it('у формы без заголовка берёт тот же фолбэк, что и публичная страница', () => {
    // Служебное «Untitled form» посторонний видеть не должен — его автор не писал.
    render(<LinkPreviewCard form={formTitled(DEFAULT_FORM_TITLE)} preview={null} />)

    expect(screen.getByText(FALLBACK_FORM_TITLE)).toBeTruthy()
    expect(screen.queryByText(DEFAULT_FORM_TITLE)).toBeNull()
  })
})
