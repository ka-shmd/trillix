import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

import { answerColumns, previewColumns, versionsDiffer } from './columns'
import { partialsListQueryOptions } from './queries'
import { partialRow, type AnswerRow } from './rows'
import { SubmissionPanel } from './SubmissionPanel'
import { SubmissionsTable } from './SubmissionsTable'
import { SubmissionsTabs } from './SubmissionsTabs'
import { formDetailQueryOptions } from '../forms/queries'
import { useFeatureAllowed } from '../plan/useFeature'
import { ApiError } from '../../shared/api/errors'
import { ProTag } from '../../shared/ProTag'
import { withoutPeriod } from '../../shared/period'
import { EmptyState, ErrorState, LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'

// Вкладка «Частичные» — то, что люди начали заполнять и не отправили
// (`partial_submissions`). У вкладки ДВА состояния, и выбирает между ними один
// факт: собирает ли форма незавершённые прямо сейчас.
//
// Сбор выключен → предложение его включить. Это единственная платная возможность
// продукта, где тариф закрывает СБОР, а не показ (спека §10.0): черновик — это
// содержимое чужого ответа, и собирать его для владельца, который его всё равно не
// увидит, значит платить приватностью респондента без всякой выгоды. Поэтому здесь
// нет «плашки с настоящим числом», как у воронки: числа нет, потому что и данных
// нет, а плашка, рекламирующая пустоту, ничего не продаёт.
//
// Сбор включён → тот же список, что на соседних вкладках: строка — запись, колонка
// — вопрос, окно по значку, удаление оттуда же (`rows.ts` объясняет, почему таблица
// одна на оба множества).
export function PartialsView({ slug }: { slug: string }) {
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  // Тумблер формы — НАМЕРЕНИЕ автора, право тарифа — разрешение. Собирается только
  // при обоих, ровно как решает сервер при отдаче публичной формы: даунгрейд
  // останавливает сбор, не дожидаясь, пока владелец вспомнит про тумблер.
  const allowed = useFeatureAllowed('submissions_partial')
  const collecting = (form.data?.collectPartial ?? false) && allowed

  const list = useInfiniteQuery({
    ...partialsListQueryOptions(formId ?? ''),
    enabled: formId !== undefined && collecting,
  })
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<AnswerRow | null>(null)

  const partials = list.data?.pages.flatMap((p) => p.partials) ?? []
  const columns = answerColumns(form.data?.draftSchema.blocks ?? [])

  // Гейт на СЕРВЕРЕ остаётся правдой: 402 сюда приходит, если тариф перестал
  // разрешать показ между загрузкой снимка тарифа и запросом списка. Рисуем то же
  // предложение, что и при выключенном тумблере, — состояние ровно то же.
  const planDenied =
    list.isError && list.error instanceof ApiError && list.error.code === 'plan_required'

  const tabs = <SubmissionsTabs slug={slug} />

  if (form.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {tabs}
        <LoadingRows rows={4} />
      </div>
    )
  }

  if (!collecting || planDenied) {
    return (
      <div className="flex flex-col gap-4">
        {tabs}
        <PartialsPromo slug={slug} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {tabs}

      {list.isPending ? (
        <LoadingRows rows={4} />
      ) : list.isError ? (
        <ErrorState
          title="Не удалось загрузить незавершённые ответы."
          onRetry={() => void list.refetch()}
        />
      ) : partials.length === 0 ? (
        <EmptyState
          title="Незавершённых пока нет"
          description="Здесь появятся ответы, которые начали заполнять и не отправили. Форма уже их собирает."
        />
      ) : (
        <>
          <SubmissionsTable
            rows={partials.map(partialRow)}
            columns={previewColumns(columns)}
            // Файлов у незавершённого ответа нет вовсе (спека §10.2): слот файла
            // выдаётся отдельным потоком и черновиком не заявляется.
            files={{}}
            showVersion={versionsDiffer(partials)}
            formId={formId ?? ''}
            onOpen={(row) => {
              setSelected(row)
              setOpen(true)
            }}
          />
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
              </Button>
            </div>
          )}
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
          {selected && (
            <SubmissionPanel
              row={selected}
              columns={columns}
              files={{}}
              formId={formId ?? ''}
              onDeleted={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Предложение включить сбор — то, что стоит на вкладке, пока форма незавершённые не
// собирает. Не `EmptyState`: у пустого состояния свой жанр и свой кегль (14/400 на
// приглушённой подложке), а здесь предложение, которое читают, а не констатация, что
// строк нет. Отсюда крупнее на ступень (20/700 и 16/400) и без подложки — блок стоит
// на холсте страницы, как обычный раздел.
//
// КНОПКА ВЕДЁТ В НАСТРОЙКИ, а не переключает тумблер на месте (решение владельца
// 2026-08-26): тумблер живёт там, у него есть соседи по смыслу (что увидит респондент,
// когда форма закроется), и второй орган управления той же настройкой на другом экране
// означал бы два места, где её ищут. Хеш ставит под курсор нужный раздел.
//
// Кнопка ОДНА на любой тариф: на настройках тумблер сам откажет с объяснением про
// тариф, а метка Pro рядом с заголовком — ссылка на страницу тарифа, то есть путь
// узнать цену тем же жестом, каким заметили ограничение.
function PartialsPromo({ slug }: { slug: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight">
        Незавершённые ответы
        <ProTag />
      </h2>
      <p className="max-w-prose text-base text-muted-foreground">
        Собирайте то, что люди начали заполнять и не отправили: видно, кого вы теряете и на каком
        вопросе. Респондент увидит предупреждение, что форма сохраняет набранное. В интеграции
        незавершённые не уезжают, писем о них не приходит.
      </p>
      <Button asChild className="mt-2">
        <Link to="/forms/$slug/settings" params={{ slug }} search={withoutPeriod} hash="partial">
          Включить сбор
        </Link>
      </Button>
    </div>
  )
}
