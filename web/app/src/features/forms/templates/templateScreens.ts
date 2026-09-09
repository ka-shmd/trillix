import { type FormSchema } from '@entities/formSchema'
import { splitFormTitle, splitPagesWithClosers, splitThankYou } from '@fields/groups'

// На какие ЭКРАНЫ режется документ шаблона, когда его смотрят: заголовок формы (он
// рисуется вне потока вопросов), страницы формы и экран после отправки.
//
// Отдельной функцией, потому что читателей у разбора ДВА и они в разных слоях: лист
// (`TemplateSheet`) рисует один экран, окно (`TemplateDialog`) ведёт по ним автора и
// для этого обязано знать, сколько их. Второй разбор рядом с первым означал бы две
// копии правил о том, какой разрыв инертен и что считается страницей, — и расхождение
// между «Страница 2 из 3» в окне и тем, что нарисовано на листе.
//
// Своих правил тут нет вовсе: три помощника `@fields` в том же порядке, в каком их
// зовёт рендерер. Заголовок отделяется ПЕРВЫМ — иначе он уехал бы в первую страницу
// обычным блоком; экран после отправки отрезается ДО разбиения на страницы — он не
// шаг формы и в счёт страниц не идёт.
export function templateScreens(schema: FormSchema) {
  const { title, rest } = splitFormTitle(schema.blocks)
  const { blocks, thankYou } = splitThankYou(rest)
  return { title, pages: splitPagesWithClosers(blocks), thankYou }
}
