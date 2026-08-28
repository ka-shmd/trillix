import {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_SIZE_MIB,
  FILE_FAMILIES,
  MAX_FILES_UPPER_BOUND,
  MAX_FILE_SIZE_UPPER_BOUND_MIB,
  type Block,
  type FileFamily,
} from '@entities/formSchema'

import { Checkbox } from '@/components/ui/checkbox'

import { useBuilderStore } from '../storeContext'
import { SelectSetting, SettingRow } from './settings'

// Настройки вопроса-файла — раздел попапа (этап 16.3): сколько файлов, какой
// потолок размера, какие семейства. На полотне их нет по общему правилу: респондент
// этих переключателей не видит, а полотно показывает ровно то, что увидит он.
//
// Числа выбираются СПИСКОМ, а не свободным вводом: у схемы строгий валидатор
// (1..10 файлов, 1..25 МиБ), и промежуточное «пусто» посреди набора ловило бы 422 на
// каждом автосейве.

// FAMILY_TITLES — как семейства называются автору. Порядок берётся из FILE_FAMILIES
// (контракт), а не из этого объекта: второй список порядка разошёлся бы с первым.
const FAMILY_TITLES: Record<FileFamily, string> = {
  image: 'Картинки',
  document: 'Документы',
  table: 'Таблицы',
  archive: 'Архивы',
}

export function FileSettings({ block }: { block: Block }) {
  const updateBlock = useBuilderStore((s) => s.updateBlock)
  const maxFiles = block.settings?.maxFiles ?? DEFAULT_MAX_FILES
  const maxFileSize = block.settings?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE_MIB
  const accept = block.settings?.accept ?? []

  const patch = (next: Partial<NonNullable<Block['settings']>>) =>
    updateBlock(block.id, { settings: { ...block.settings, ...next } })

  // Пустой accept значит «всё разрешённое продуктом». Снятая последняя галочка
  // возвращает именно это состояние, а не «ничего нельзя»: вопрос, не принимающий
  // ни одного типа, — не настройка, а сломанная форма.
  const toggleFamily = (family: FileFamily, on: boolean) => {
    const current = accept.length > 0 ? accept : [...FILE_FAMILIES]
    const next = on ? [...current, family] : current.filter((f) => f !== family)
    patch({ accept: next.length === 0 || next.length === FILE_FAMILIES.length ? undefined : next })
  }

  return (
    <>
      <SettingRow label="Файлов">
        <SelectSetting
          label="Сколько файлов принимает вопрос"
          value={maxFiles}
          options={Array.from({ length: MAX_FILES_UPPER_BOUND }, (_, i) => i + 1)}
          onChange={(v) => patch({ maxFiles: v })}
        />
      </SettingRow>
      <SettingRow label="Размер, МиБ">
        <SelectSetting
          label="Потолок размера одного файла в мебибайтах"
          value={maxFileSize}
          options={[1, 2, 5, 10, 15, 20, MAX_FILE_SIZE_UPPER_BOUND_MIB]}
          onChange={(v) => patch({ maxFileSize: v })}
        />
      </SettingRow>
      <SettingRow label="Принимать">
        <div className="flex flex-wrap gap-2">
          {FILE_FAMILIES.map((family) => {
            const on = accept.length === 0 || accept.includes(family)
            return (
              <label
                key={family}
                className="flex items-center gap-2 rounded border px-2 py-1 text-sm"
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={(v) => toggleFamily(family, v === true)}
                />
                {FAMILY_TITLES[family]}
              </label>
            )
          })}
        </div>
      </SettingRow>
    </>
  )
}
