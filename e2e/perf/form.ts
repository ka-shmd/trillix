import type { Page } from '@playwright/test'

// Генератор формы заданного размера для замера полотна.
//
// Состав намеренно НЕ синтетический («199 одинаковых абзацев»): цена ре-рендера
// зависит от того, сколько на полотне инпутов, sortable-узлов и групп, а у формы из
// одних текстовых строк их вдвое меньше, чем у настоящей. Поэтому единица здесь —
// вопрос из двух блоков (подпись + поле), типы полей идут по кругу, и каждый пятый
// вопрос получает список вариантов: это даёт полотну и инпуты вариантов, и
// вложенный SortableContext списка, то есть тот же профиль, что у живой формы.
//
// Размер задаётся числом блоков АВТОРА (заголовок формы в потолок MAX_BLOCKS не
// входит — см. formSchema.ts): нечётный остаток добирается одиночным абзацем.

type Span = { t: string }
type Block = {
  id: string
  groupId: string
  type: string
  text?: Span[]
  settings?: { options?: { id: string; label: string }[] }
}

const FIELD_TYPES = ['short_text', 'email', 'single_choice', 'scale', 'long_text', 'phone']

export function buildBlocks(authored: number, title: string): Block[] {
  const blocks: Block[] = [
    { id: 'ft', groupId: 'gft', type: 'form_title', text: [{ t: title }] },
  ]
  const pairs = Math.floor(authored / 2)
  for (let i = 0; i < pairs; i++) {
    const gid = `g${i}`
    const type = FIELD_TYPES[i % FIELD_TYPES.length]!
    // Подпись — 'title', а не 'label': именно её кладёт вопрос-бандл (addQuestionAfter
    // в store.ts), и замерять надо ту форму, которую собирают руками.
    blocks.push({ id: `c${i}`, groupId: gid, type: 'title', text: [{ t: `Вопрос номер ${i + 1}` }] })
    const field: Block = { id: `f${i}`, groupId: gid, type }
    if (type === 'single_choice') {
      field.settings = {
        options: [
          { id: `o${i}a`, label: 'Первый вариант' },
          { id: `o${i}b`, label: 'Второй вариант' },
          { id: `o${i}c`, label: 'Третий вариант' },
        ],
      }
    }
    blocks.push(field)
  }
  if (authored % 2 === 1) {
    blocks.push({
      id: 'tail',
      groupId: 'gtail',
      type: 'text',
      text: [{ t: 'Заключительный абзац формы.' }],
    })
  }
  return blocks
}

// Заводит форму нужного размера и возвращает её slug. Всё через API: предмет
// замера — полотно на готовой форме, а не её сборка.
export async function createForm(page: Page, authored: number): Promise<string> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf_token')?.value
  if (!csrf) throw new Error('нет csrf-cookie: сессия не заведена')
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
  const title = `Замер полотна ${authored} блоков`

  const created = await page.request.post('/api/v1/forms', { headers, data: { title } })
  if (!created.ok()) throw new Error(`POST /forms: ${created.status()} ${await created.text()}`)
  const form = (await created.json()) as { id: string; slug: string; updatedAt: string }

  const saved = await page.request.patch(`/api/v1/forms/${form.id}`, {
    headers,
    data: {
      updatedAt: form.updatedAt,
      draftSchema: { schemaVersion: 4, blocks: buildBlocks(authored, title) },
    },
  })
  if (!saved.ok()) throw new Error(`PATCH /forms: ${saved.status()} ${await saved.text()}`)
  return form.slug
}
