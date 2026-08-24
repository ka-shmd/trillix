import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { type FormFunnel, type FunnelStep } from '../../entities/funnel'
import { formDetailQueryOptions } from '../../features/forms/queries'
import { funnelQueryOptions } from '../../features/funnel/queries'
import { CompletionCards } from '../../features/insights/Cards'
import { pluralPeople, pluralViews } from '../../shared/format'
import { ApiError } from '../../shared/api/errors'
import { Button } from '@/components/ui/button'

// Вкладка «Отвалы» (/forms/$slug/insights/drop-offs): на каком вопросе люди уходят.
//
// Шаг 6 дал владельцу дробь «187 просмотров → 12 ответов»: она говорит, что форма
// теряет людей, но молчит, где. Этот экран отвечает на «где» — и из него следует
// конкретное действие: убрать вопрос или сделать необязательным.
//
// Свой маршрут, а не секция сводки (решение владельца): другой источник данных
// (визиты, не ответы), своё пустое состояние и свои загрузка/ошибка — на общей
// странице получились бы два спиннера и две коробки ошибки. Бары — на CSS, как в
// сводке: графических библиотек в проекте нет, список зависимостей заморожен.
export const Route = createFileRoute('/_app/forms/$slug/_manage/insights/drop-offs')({
  component: FunnelPage,
})

function FunnelPage() {
  // URL адресует форму slug'ом; UUID для запроса берём из загруженной формы — как на
  // страницах ответов и сводки.
  const { slug } = Route.useParams()
  const { period } = Route.useSearch()
  const form = useQuery(formDetailQueryOptions(slug))
  const formId = form.data?.id
  const funnel = useQuery({
    ...funnelQueryOptions(formId ?? '', period),
    enabled: formId !== undefined,
  })

  // Карточки здесь СВОИ: вкладка про прохождение формы, а не про трафик. «Начали
  // отвечать» и «Завершили» — это верх воронки, поэтому они и приезжают из неё.
  const cards = (
    <CompletionCards
      slug={slug}
      period={period}
      started={funnel.data ? funnel.data.visits - funnel.data.leftBeforeFirst : undefined}
      completed={funnel.data?.submitted}
      pending={funnel.isPending}
    />
  )

  if (funnel.isPending) {
    return (
      <>
        {cards}
        <p className="text-sm text-muted-foreground">Считаем воронку…</p>
      </>
    )
  }
  // Воронка закрыта тарифом. Показываем НАСТОЯЩЕЕ число не дошедших — оно уже
  // загружено вместе с формой (визиты собираются для всех планов, гейт стоит на
  // показе разбивки). Плашка, рекламирующая пустоту, не продаёт ничего.
  if (funnel.isError && funnel.error instanceof ApiError && funnel.error.code === 'plan_required') {
    const notFinished = (form.data?.visitCount ?? 0) - (form.data?.visitSubmittedCount ?? 0)
    return (
      <div className="mx-auto mt-12 max-w-md text-center">
        <h2 className="text-lg font-medium">
          {notFinished > 0
            ? `Не дошли до конца формы: ${notFinished} ${pluralPeople(notFinished)}`
            : 'Воронка отвала'}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {notFinished > 0
            ? 'Откройте тариф с аналитикой, чтобы увидеть, на каких именно вопросах они уходят.'
            : 'Разбивка по вопросам доступна на тарифе с аналитикой. Визиты уже собираются — данные копятся и никуда не денутся.'}
        </p>
        <Button asChild size="sm" className="mt-4">
          <Link to="/settings/plan">Посмотреть тариф</Link>
        </Button>
      </div>
    )
  }
  if (funnel.isError) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
        <p className="mb-3 text-sm">Не удалось посчитать воронку.</p>
        <Button variant="outline" size="sm" onClick={() => funnel.refetch()}>
          Повторить
        </Button>
      </div>
    )
  }
  if (funnel.data.visits === 0) {
    return (
      <>
        {cards}
        <div className="mx-auto mt-12 max-w-md text-center">
          <h2 className="text-lg font-medium">Просмотров пока нет</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Поделитесь ссылкой на форму — как только её откроют, здесь появится, на каком
            вопросе люди уходят.
          </p>
        </div>
      </>
    )
  }

  return (
    <>
      {cards}
      <FunnelView funnel={funnel.data} />
    </>
  )
}

function FunnelView({ funnel }: { funnel: FormFunnel }) {
  const { visits, submitted, leftBeforeFirst, steps } = funnel

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {visits} {pluralViews(visits)}
      </p>

      <Stage title="Открыли форму" count={visits} base={visits} />

      {leftBeforeFirst > 0 && (
        <p className="text-sm text-muted-foreground">
          {leftBeforeFirst} ушли, не тронув ни одного вопроса.
        </p>
      )}

      {steps.length === 0 ? (
        // Визиты есть, а вопросов нет: все вопросы формы удалены после сбора.
        // Объяснение, а не пустой экран — иначе выглядит как поломка.
        <p className="text-sm text-muted-foreground">
          В опубликованных версиях формы нет вопросов — воронке нечего показывать.
        </p>
      ) : (
        <ol className="flex flex-col gap-4">
          {steps.map((step, i) => (
            <li key={step.blockId}>
              <StepCard step={step} index={i} base={visits} />
            </li>
          ))}
        </ol>
      )}

      <Stage title="Отправили форму" count={submitted} base={visits} />

      {/* Честная оговорка на самом экране, а не только в документации: пока форма —
          одна длинная страница, «дошёл» означает «коснулся поля». Проскроллившего и
          передумавшего не видно, и владелец должен знать это, читая числа. */}
      <p className="mt-2 text-xs text-muted-foreground">
        «Дошёл до вопроса» считается по касанию поля: человек, который пролистал форму
        и ушёл, ничего не заполнив, в шаги не попадает. С приходом многостраничных форм
        счёт станет точнее.
      </p>
    </div>
  )
}

// Stage — верх и низ воронки (открыли / отправили): те же метрики, что на карточке
// дашборда, поэтому выглядят иначе, чем шаги-вопросы.
function Stage({ title, count, base }: { title: string; count: number; base: number }) {
  return (
    <article className="rounded-lg border bg-muted/30 p-5">
      <div className="flex justify-between gap-4">
        <h2 className="font-medium">{title}</h2>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {count} · {percent(count, base)} %
        </span>
      </div>
      <ProgressBar pct={percent(count, base)} />
    </article>
  )
}

function StepCard({ step, index, base }: { step: FunnelStep; index: number; base: number }) {
  const pct = percent(step.reached, base)
  return (
    <article className="rounded-lg border p-5">
      <div className="flex justify-between gap-4">
        <h2 className="min-w-0 break-words font-medium">
          {index + 1}. {step.label}
        </h2>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {step.reached} · {pct} %
        </span>
      </div>
      <ProgressBar pct={pct} />
      <p className="mt-2 text-sm text-muted-foreground">{droppedPhrase(step.droppedHere)}</p>
    </article>
  )
}

// Полоска декоративна (aria-hidden): то же число уже прочитано текстом рядом,
// дублировать его скринридеру незачем (как в сводке).
function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  )
}

// Ноль в знаменателе сюда не доходит (экран «нет просмотров» выше), но проверка
// остаётся: NaN в ширине полоски ломал бы вёрстку молча.
function percent(count: number, base: number): number {
  return base > 0 ? Math.round((count / base) * 100) : 0
}

// Фраза целиком, а не склонение одного слова: в ней согласуются ДВА глагола
// («остановился … не пошёл» против «остановились … не пошли»), и склонять их по
// отдельности значит рано или поздно получить «1 остановился и дальше не пошли».
function droppedPhrase(n: number): string {
  if (n === 0) return 'Здесь никто не остановился.'
  // 1, 21, 31… — единственное число; 11 — исключение (одиннадцать остановились).
  const singular = n % 10 === 1 && n % 100 !== 11
  return singular
    ? `${n} остановился здесь и дальше не пошёл.`
    : `${n} остановились здесь и дальше не пошли.`
}
