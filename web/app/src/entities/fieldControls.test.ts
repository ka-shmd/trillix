import { describe, expect, it } from 'vitest'

import { BLOCK_TYPES } from '@entities/blocks/contract'
import { isAnswerableType } from '@entities/formSchema'
import { CONTROLS } from '@fields/kinds/index'

// Реестр контролов (этап 16.1б) сторожится с одной стороны компилятором, с другой —
// отсюда. tsc требует ключ на КАЖДЫЙ тип блока, но не мешает написать `scale: null`, а
// `null` значит «контрола нет»: отвечаемый тип с null молча отрисовал бы пустоту вместо
// поля — форма без поля ответа, которую автор считает собранной. Обратная ошибка тише, но
// того же рода: контрол у неотвечаемого типа не нужен никому и означает, что тип
// заведён не в ту семью.
//
// Это ровно тот класс ошибки, который этап убирал в контрактном слое, поэтому источник
// правды здесь — семья типа из реестра (isAnswerableType), а не второй список.
describe('реестр контролов покрывает ровно отвечаемые типы', () => {
  for (const t of BLOCK_TYPES) {
    it(t, () => {
      if (isAnswerableType(t)) {
        expect(CONTROLS[t], `у отвечаемого типа ${t} нет контрола`).toBeTypeOf('function')
      } else {
        expect(CONTROLS[t], `у неотвечаемого типа ${t} есть контрол`).toBeNull()
      }
    })
  }
})
