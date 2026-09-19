import { z } from 'zod'

// Доменные типы ответов (submissions) кабинета. Единственный источник —
// эти Zod-схемы (web/CLAUDE.md), зеркалят DTO из internal/submissions/handler.go.

// Значение одного ответа: текст/single_choice — строка, multi_choice — массив id
// опций (тот же формат, что @fields/answer.ts). Карта block_id → значение.
export const answerValueSchema = z.union([z.string(), z.array(z.string())])
export type AnswerValue = z.infer<typeof answerValueSchema>

// Строка раздела «Ответы»: отправленный ответ ЛИБО незавершённый — вкладка «Все
// ответы» отдаёт оба вида одним списком, и различает их `kind`.
//
// updatedAt и lastBlockId сервер печатает только у черновика, поэтому они
// необязательны: у отправленного ответа не было ни правок после отправки, ни места,
// где человек остановился.
export const submissionSchema = z.object({
  kind: z.enum(['submission', 'partial']),
  id: z.string(),
  // Номер версии формы, по которой отправлен ответ (в таблице — колонка «версия»).
  formVersion: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  lastBlockId: z.string().default(''),
  answers: z.record(z.string(), answerValueSchema),
  // Источник и класс устройства визита, из которого пришёл ответ (фаза 30). Нет у
  // ответа без визита и в ленте «Все ответы».
  visitSource: z.string().optional(),
  visitDevice: z.string().optional(),
})

export type Submission = z.infer<typeof submissionSchema>

// GET /forms/{id}/submissions: страница + непрозрачный курсор (null — последняя) +
// счётчики. total — сколько ВИДНО; hidden — сколько скрыто квотой тарифа (0014):
// эти ответы сохранены и откроются после перехода на план, который их вмещает.
// Приложенный файл (фаза 24): id загрузки → имя и размер. Отдельной картой рядом
// со страницей, а не внутри answers: в самом ответе лежат ТОЛЬКО id, и правда о
// файле живёт на сервере. Ссылки здесь нет намеренно — подпись хранилища живёт
// минуту и протухла бы раньше, чем автор доскроллит; скачивание идёт через
// GET /api/v1/files/{id}.
export const answerFileSchema = z.object({
  name: z.string(),
  size: z.number().int(),
})
export type AnswerFile = z.infer<typeof answerFileSchema>

export const submissionsPageSchema = z.object({
  submissions: z.array(submissionSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
  hidden: z.number().int(),
  // Пусто у форм без вопросов-файлов — сервер поле не печатает вовсе.
  files: z.record(z.string(), answerFileSchema).default({}),
})

export type SubmissionsPage = z.infer<typeof submissionsPageSchema>

// GET /forms/{id}/submissions/{sid} — ОДИН ответ с его файлами. Нужен окну ответа,
// открытому не из списка: карточка записи на полотне расписания знает только id.
// Форма та же, что у элемента страницы, — окно рисуется одним компонентом.
export const submissionOneSchema = z.object({
  submission: submissionSchema,
  files: z.record(z.string(), answerFileSchema).default({}),
})

export type SubmissionOne = z.infer<typeof submissionOneSchema>

// Черновик — то, что человек набрал и НЕ отправил (`partial_submissions`).
// Зеркалит partialResponse из internal/submissions/handler.go.
//
// Ключ строки — id ВИЗИТА, а не свой: черновик принадлежит одному визиту, и второе
// автосохранение перезаписывает первый, а не заводит вторую строку. Отсюда visitId
// в имени поля: назови его id — и то, чем адресуется удаление, стало бы неочевидно.
//
// Файлов у черновика нет вовсе (спека §10.2): слот файла выдаётся отдельным потоком
// и считается в квоту хранилища, а черновик его не заявляет.
export const partialSubmissionSchema = z.object({
  visitId: z.string(),
  formVersion: z.number().int(),
  // createdAt — когда человек начал заполнять, updatedAt — последняя правка. В
  // таблице показывается вторая: черновик меняется, пока он печатает.
  createdAt: z.string(),
  updatedAt: z.string(),
  // Вопрос, на котором остановился; пусто — рендерер его не прислал.
  lastBlockId: z.string(),
  answers: z.record(z.string(), answerValueSchema),
})

export type PartialSubmission = z.infer<typeof partialSubmissionSchema>

// GET /forms/{id}/partials: страница + непрозрачный составной курсор (null —
// последняя) + общее число черновиков.
export const partialSubmissionsPageSchema = z.object({
  partials: z.array(partialSubmissionSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
})

export type PartialSubmissionsPage = z.infer<typeof partialSubmissionsPageSchema>

// Число ответов за окно наблюдения — карточка «Ответы» над вкладками аналитики.
// Зеркалит countResponse из internal/submissions/handler.go.
export const submissionsCountSchema = z.object({
  submissions: z.number().int(),
  // За прошлое окно той же длины (фаза 30); нет у «всего времени».
  previous: z.number().int().optional(),
})
export type SubmissionsCount = z.infer<typeof submissionsCountSchema>
