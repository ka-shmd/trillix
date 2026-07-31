import { describe, expect, it } from 'vitest'

import { BLOCK_TYPES } from '@entities/blocks/contract'
import {
  carriesText,
  isAnswerableType,
  isChoiceType,
  isContentType,
  supportsPlaceholder,
} from '@entities/formSchema'

import { EDITOR_KINDS, editorKind } from './index'

// Реестр редактора — третий слой среза по типам, и он обязан сходиться с первым
// (контрактом). tsc держит только полноту: ключ есть у каждого типа, поля обязательны. А
// вот СМЫСЛ полей он не проверяет — поверхность строки можно объявить любую, и расхождение
// с контрактом окажется не ошибкой сборки, а молчаливой поломкой полотна:
//
//   • поверхность 'text' у типа, который не несёт своего текста, — строка примет ввод,
//     а автосейв получит 422 («тип X не несёт собственного текста»);
//   • поверхность 'placeholder' у типа без плейсхолдера — автор правит настройку, которую
//     схема у этого типа игнорирует, и правка исчезает при следующей загрузке;
//   • поверхность 'choice' у не-choice — список вариантов, которых у типа нет.
//
// Поэтому источник правды здесь — предикаты контракта, а не второй список.
describe('реестр редактора сходится с контрактом', () => {
  for (const t of BLOCK_TYPES) {
    it(t, () => {
      const row = editorKind(t).row
      // Заголовок формы — единственный тип со своей строкой (FormTitleRow): BlockRow его
      // не получает вовсе, поэтому фактов о строке у него нет.
      if (t === 'form_title') {
        expect(row).toBeNull()
        return
      }
      expect(row, `у типа ${t} нет фактов о строке`).not.toBeNull()
      if (!row) return

      expect(row.surface === 'text', 'поверхность текста ⟺ тип несёт свой текст').toBe(
        carriesText(t),
      )
      expect(row.surface === 'choice', 'поверхность вариантов ⟺ choice-тип').toBe(isChoiceType(t))
      expect(
        row.surface === 'placeholder',
        'поверхность плейсхолдера ⟺ тип его поддерживает',
      ).toBe(supportsPlaceholder(t))
    })
  }

  it('в меню вставки стоят отвечаемые типы и лэйаут, но не заголовок формы', () => {
    for (const t of BLOCK_TYPES) {
      const { menu } = editorKind(t)
      // «Вопросы» и «Отдельные поля» — два способа вставить ОТВЕЧАЕМЫЙ блок: бандлом с
      // заголовком и голым. Оба раздела покрывают ровно отвечаемые типы.
      expect(menu.question, `${t} в разделе «Вопросы»`).toBe(isAnswerableType(t))
      expect(menu.field, `${t} в разделе «Отдельные поля»`).toBe(isAnswerableType(t))
      // «Лэйаут» — подписи и контент, кроме заголовка формы: он единственный и приколот
      // первой строкой документа, вставке не подлежит.
      expect(menu.layout, `${t} в разделе «Лэйаут»`).toBe(isContentType(t) && t !== 'form_title')
    }
  })

  it('дефолты нового блока не приносят чужих ключей настроек', () => {
    // Скелет блока создаётся с пустыми settings, а дефолты типа их ЗАМЕНЯЮТ: ключ, который
    // схема у этого типа не разрешает, отвергнет ValidateSchema — то есть новый блок,
    // созданный меню, не сохранится вовсе.
    for (const [t, kind] of Object.entries(EDITOR_KINDS)) {
      const keys = Object.keys(kind.defaults?.settings ?? {})
      for (const key of keys) {
        if (key === 'options') {
          expect(isChoiceType(t as never), `${t}: дефолт с опциями у не-choice`).toBe(true)
        }
        if (key === 'scaleMin' || key === 'scaleMax') {
          expect(t, `${t}: дефолт со шкалой у чужого типа`).toBe('scale')
        }
        if (key === 'imageKey') {
          expect(t, `${t}: дефолт с картинкой у чужого типа`).toBe('image')
        }
      }
    }
  })
})
