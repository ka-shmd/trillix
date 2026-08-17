import { type BlockKindContract } from './contract'
import { FILE_FAMILIES, MAX_FILES_UPPER_BOUND, MAX_FILE_SIZE_UPPER_BOUND_MIB } from './limits'
import { type Settings } from './settings'

// Файл в ответе (фаза 24, docs/design/answer-files.md). Отвечаемый тип; собственного
// текста не несёт — подпись живёт блоком рядом, как у остальных полей.
//
// Ответ — массив id загрузок, выданных сервером. Ни имени, ни размера, ни MIME в
// ответе нет: это утверждения клиента, а правда о файле лежит в submission_files и
// проверена у хранилища.
export const file: BlockKindContract = {
  family: 'answer',
  carriesText: false,
  canShareRow: true,
  ownSettings: ['maxFiles', 'maxFileSize', 'accept'],
  supportsPlaceholder: false,
  requiresCaption: true,
  issues: (settings: Settings) => {
    const out = []
    const n = settings.maxFiles
    if (n !== undefined && (n < 1 || n > MAX_FILES_UPPER_BOUND)) {
      out.push({ message: `от 1 до ${MAX_FILES_UPPER_BOUND} файлов`, path: ['maxFiles'] })
    }
    const size = settings.maxFileSize
    if (size !== undefined && (size < 1 || size > MAX_FILE_SIZE_UPPER_BOUND_MIB)) {
      out.push({
        message: `от 1 до ${MAX_FILE_SIZE_UPPER_BOUND_MIB} МиБ`,
        path: ['maxFileSize'],
      })
    }
    const accept = settings.accept
    if (accept && new Set(accept).size !== accept.length) {
      out.push({ message: 'повторяющееся семейство файлов', path: ['accept'] })
    }
    if (accept?.some((a) => !FILE_FAMILIES.includes(a))) {
      out.push({ message: 'неизвестное семейство файлов', path: ['accept'] })
    }
    return out
  },
}
