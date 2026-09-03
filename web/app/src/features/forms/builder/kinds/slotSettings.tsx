import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { formKeys } from '../../keys'
import { setFormSchedule } from '../../api'
import { schedulesQueryOptions } from '../../../../shared/schedules/queries'
import { useFormFacts } from '../formFacts'
import { SettingRow } from './settings'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Расписание вопроса о записи — раздел попапа (этап 16.3): респондент этого выбора не
// видит, он видит его последствие — свободное время.
//
// ⚠ ВЫБОР ХРАНИТСЯ НЕ В СХЕМЕ, А ЖИВОЙ КОЛОНКОЙ forms.schedule_id (ADR §10). Схема
// замерзает при публикации, и ссылка в ней потребовала бы перепубликации на смену
// расписания — а живая форма до неё продолжала бы писать в старое. Автор разницы не
// видит: он кликает блок и выбирает расписание.
//
// Отсюда же устройство раздела: он не зовёт updateBlock, как остальные настройки, а
// патчит саму форму и инвалидирует её деталь.
export function SlotSettings() {
  const facts = useFormFacts()
  const qc = useQueryClient()
  const schedules = useQuery({
    ...schedulesQueryOptions(facts?.workspaceId ?? ''),
    enabled: Boolean(facts?.workspaceId),
  })

  if (!facts) return null
  const form = facts

  async function choose(next: string) {
    // Формы может ещё не быть: расписание автор вправе выбрать первым действием, и
    // тогда черновик заводит оно само (FormFacts.id — обещание).
    const formId = typeof form.id === 'string' && form.id !== '' ? form.id : await resolve(form.id)
    await setFormSchedule(formId, next === NONE ? null : next)
    // Деталь формы несёт scheduleId — без инвалидации попап показывал бы прежний
    // выбор до перезагрузки страницы.
    await qc.invalidateQueries({ queryKey: formKeys.detailAll() })
  }

  const value = form.scheduleId ?? NONE
  const empty = schedules.data?.length === 0

  return (
    <>
      <SettingRow label="Расписание">
        <Select value={value} onValueChange={(next) => void choose(next)} disabled={empty}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Не выбрано" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Не выбрано</SelectItem>
            {schedules.data?.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      {/* Форма без выбранного расписания СОХРАНЯЕТСЯ, но не публикуется (гейт в
          forms.Publish). Сказать об этом надо здесь: узнавать про отказ на кнопке
          «Опубликовать» — значит узнавать в тот момент, когда автор уже считает
          форму готовой. */}
      {!form.scheduleId && !empty && (
        <p className="px-2 pb-1 text-xs text-muted-foreground">
          Пока расписание не выбрано, форму нельзя опубликовать.
        </p>
      )}
      {/* ⚠ ССЫЛКА ВЕДЁТ В ПРОСТРАНСТВО ФОРМЫ, а не «в расписания вообще». Пока она
          вела на общий адрес, автор заводил расписание в ЛИЧНОМ пространстве и не
          находил его в форме команды (отчёт владельца 2026-09-03). */}
      {empty && (
        <p className="px-2 pb-1 text-xs text-muted-foreground">
          В этом пространстве ещё нет расписаний.{' '}
          <Link
            to="/workspaces/$workspaceSlug/schedules"
            params={{ workspaceSlug: form.workspaceSlug }}
            className="underline"
          >
            Завести расписание
          </Link>
        </p>
      )}
    </>
  )
}

// NONE — «расписание не выбрано». Отдельное значение, а не пустая строка: Radix
// трактует пустую строку как «выбора нет» и рисует плейсхолдер вместо пункта.
const NONE = 'none'

const resolve = (source: Exclude<ReturnType<typeof useFormFacts>, null>['id']) =>
  typeof source === 'string' ? Promise.resolve(source) : source()
