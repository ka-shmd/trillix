import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'

import { humanError } from '../../../../shared/api/errors'
import { useScheduleChoice } from './scheduleChoice'
import { SETTING_SELECT, SETTING_SELECT_ITEM, SettingRow } from './settings'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Расписание вопроса о записи — раздел попапа (этап 16.3): респондент этого выбора не
// видит, он видит его последствие — свободное время. Вторая точка входа — плашка на
// полотне, пока расписание не выбрано (SlotControl); выбор у них общий (scheduleChoice.ts).
export function SlotSettings() {
  const { facts, schedules, choose } = useScheduleChoice()

  if (!facts) return null

  const value = facts.scheduleId ?? NONE
  const empty = schedules.data?.length === 0

  return (
    <>
      <SettingRow label="Расписание">
        <Select
          value={value}
          onValueChange={(next) =>
            choose(next === NONE ? null : next).catch((err: unknown) =>
              toast.error(humanError(err, 'Не удалось выбрать расписание')),
            )
          }
          disabled={empty}
        >
          <SelectTrigger size="sm" className={`w-56 ${SETTING_SELECT}`}>
            <SelectValue placeholder="Не выбрано" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE} className={SETTING_SELECT_ITEM}>
              Не выбрано
            </SelectItem>
            {schedules.data?.map((s) => (
              <SelectItem key={s.id} value={s.id} className={SETTING_SELECT_ITEM}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      {/* ПОЧЕМУ ЗДЕСЬ НЕТ ПОДПИСИ «форму нельзя опубликовать». Условий публикации у
          формы записи два (расписание и обязательный вопрос о почте), и живут они на
          самой кнопке «Опубликовать»: она гаснет, а тултип называет причину (решение
          владельца 2026-09-04, publishGate.ts). Подпись рядом с контролом сказала бы
          половину — про второе условие этот попап не знает ничего. */}
      {/* ⚠ ССЫЛКА ВЕДЁТ В ПРОСТРАНСТВО ФОРМЫ, а не «в расписания вообще». Пока она
          вела на общий адрес, автор заводил расписание в ЛИЧНОМ пространстве и не
          находил его в форме команды (отчёт владельца 2026-09-03). */}
      {empty && (
        <p className="px-2 pb-1 text-xs text-muted-foreground">
          В этом пространстве ещё нет расписаний.{' '}
          <Link
            to="/w/$workspaceSlug/schedules"
            params={{ workspaceSlug: facts.workspaceSlug }}
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
