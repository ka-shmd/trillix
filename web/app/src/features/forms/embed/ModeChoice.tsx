import { type FormDetail } from '../../../entities/form'
import { MODE_HINTS, MODE_TITLES, type EmbedMode } from '../embedSnippet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

// ВЫБОР ВИДА — ТРИ ВКЛАДКИ, а не дропдаун: видов ровно три, они называются одним
// словом, и это единственный выбор экрана, меняющий его целиком (набор настроек,
// макет, код). Дропдаун прятал бы два варианта из трёх за нажатием.
//
// Стоит в разделе «Встраивание», а не среди настроек: вид — не опция вставки, а то,
// что вставляется; опции же у каждого вида свои и меняются вместе с ним.
//
// Значение живёт в адресе (`?mode=`), поэтому вкладки — контролируемые: активной
// становится не нажатая, а та, на которую увёл роутер. Тем же и работает «Назад».
export function ModeChoice({
  form,
  mode,
  onModeChange,
}: {
  form: FormDetail
  mode: EmbedMode
  onModeChange: (mode: EmbedMode) => void
}) {
  // У формы есть разрывы страниц — единственная подсказка выбора не про вкус.
  const multipage = form.draftSchema.blocks.some((b) => b.type === 'page_break')

  return (
    <div className="flex flex-col gap-2">
      <Tabs value={mode} onValueChange={(v) => onModeChange(v as EmbedMode)}>
        <TabsList className="w-full">
          <TabsTrigger value="block">{MODE_TITLES.block}</TabsTrigger>
          <TabsTrigger value="widget">{MODE_TITLES.widget}</TabsTrigger>
          <TabsTrigger value="page">{MODE_TITLES.page}</TabsTrigger>
        </TabsList>
      </Tabs>
      <p className="text-xs text-muted-foreground">{MODE_HINTS[mode]}</p>
      {multipage && mode === 'block' && (
        <p className="text-xs text-muted-foreground">
          У формы есть разрывы страниц — ей обычно лучше подходит «Страница».
        </p>
      )}
    </div>
  )
}
