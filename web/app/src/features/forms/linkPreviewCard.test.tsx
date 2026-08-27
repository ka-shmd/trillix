// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { newFormDetail } from './draft'
import { LinkPreviewCard } from './LinkPreviewCard'
import { EMPTY_LINK_PREVIEW, type FormDetail } from '../../entities/form'

afterEach(cleanup)

// Карточка зеркалит правило подстановки с бэка (internal/forms/public_page.go):
// поле карточки, если оно заполнено, иначе дефолт. Разъехавшись с сервером, она
// перестаёт быть предпросмотром и становится картинкой — врущей ровно там, где
// проверить её глазами невозможно (карточку рисует чужой мессенджер).
function formWithLabel(label: string): FormDetail {
  const form = newFormDetail()
  return {
    ...form,
    title: 'Опрос читателей',
    draftSchema: {
      ...form.draftSchema,
      blocks: [{ id: 'b1', type: 'label', groupId: 'g1', text: [{ t: label }] }],
    },
  }
}

describe('LinkPreviewCard', () => {
  it('без своей карточки показывает заголовок формы и тизер из подписей', () => {
    render(<LinkPreviewCard form={formWithLabel('Как вам номер?')} preview={null} />)

    expect(screen.getByText('Опрос читателей')).toBeTruthy()
    expect(screen.getByText('Как вам номер?')).toBeTruthy()
  })

  it('заполненные поля карточки перебивают дефолты', () => {
    render(
      <LinkPreviewCard
        form={formWithLabel('Как вам номер?')}
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
  })

  it('пустое поле карточки оставляет дефолт, а не пустоту', () => {
    render(
      <LinkPreviewCard
        form={formWithLabel('Как вам номер?')}
        preview={{ ...EMPTY_LINK_PREVIEW, title: 'Февральский номер' }}
      />,
    )

    expect(screen.getByText('Февральский номер')).toBeTruthy()
    // Описание не задано — остаётся тизер из подписей вопросов.
    expect(screen.getByText('Как вам номер?')).toBeTruthy()
  })

  it('форма без подписей получает тот же фолбэк описания, что и публичная страница', () => {
    render(<LinkPreviewCard form={formWithLabel('   ')} preview={null} />)

    expect(screen.getByText('Онлайн-форма — заполните и отправьте ответ.')).toBeTruthy()
  })
})
