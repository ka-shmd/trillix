import { type BlockType } from '@entities/formSchema'

import { consentControl } from './consent'
import { type Control } from './contract'
import { dateControl } from './date'
import { dropdownControl } from './dropdown'
import { emailControl } from './email'
import { fileControl } from './file'
import { longTextControl } from './longText'
import { multiChoiceControl } from './multiChoice'
import { numberControl } from './number'
import { phoneControl } from './phone'
import { scaleControl } from './scale'
import { shortTextControl } from './shortText'
import { singleChoiceControl } from './singleChoice'

// Реестр контролов — как каждый тип выглядит у респондента (этап 16.1б).
//
// Record по ВСЕМ типам, включая неотвечаемые: `null` у них — объявленный факт «контрола
// нет», а не пропуск. До фазы 16 это был switch, где контентные типы стояли двумя
// ветками `return null` «для исчерпанности», а подписи и заголовок формы не стояли вовсе:
// до FieldControl они не доходят, потому что BlockField отсекает их выше. Разница в том,
// что теперь тип нельзя ЗАБЫТЬ — tsc требует ключ, — а «у меня нет контрола» приходится
// написать, и это ровно то знание, за которым сюда придут.
export const CONTROLS: Record<BlockType, Control | null> = {
  short_text: shortTextControl,
  long_text: longTextControl,
  email: emailControl,
  phone: phoneControl,
  number: numberControl,
  scale: scaleControl,
  single_choice: singleChoiceControl,
  dropdown: dropdownControl,
  multi_choice: multiChoiceControl,
  date: dateControl,
  consent: consentControl,
  file: fileControl,
  // Неотвечаемые: рисуются как статический контент (ContentBlock в BlockField), контрола
  // не имеют по устройству.
  title: null,
  label: null,
  heading: null,
  heading_2: null,
  heading_3: null,
  text: null,
  image: null,
  // Разрыв страницы контрола не имеет и у респондента не рисуется вовсе: его потребляет
  // splitPages, превращая в границу шага. До BlockField он доходит только на поверхности,
  // которую ещё не научили страницам, — там он рисуется ничем (BlockField).
  page_break: null,
  // Блок условной логики у респондента не рисуется вовсе (BlockField отсекает выше):
  // он про поведение формы, а не про её содержимое.
  logic: null,
  form_title: null,
}

export { type Control, type ControlProps } from './contract'
