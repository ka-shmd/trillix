import { useState } from 'react'

import { MAX_SCHEDULE_NOTE_LEN, type TimeWindow } from '../../entities/schedule'
import { datesLabel, everyLabel, onlyLabel } from './canvas'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// Что автор размечает протяжкой по полотну.
//
// ОДНО ОКНО ВМЕСТО ДВУХ ВОПРОСОВ ПОДРЯД (решение владельца 2026-09-05). Протяжка по
// датированной неделе двусмысленна дважды: неизвестно, что за время размечено, и — у
// часов приёма — в каком объёме действует правило. Раньше на это отвечали два
// последовательных вопроса всплывашки, потом — две отдельные поверхности полотна;
// теперь таб отвечает на первое, а поле внутри таба на второе, и оба ответа видны
// разом, а не по очереди.
//
// ⚠ ДО НАЖАТИЯ НЕ ПРИМЕНЯЕТСЯ НИЧЕГО. Закрыть окно — значит не сделать ничего:
// полотно рисует приём и занятость одним движением мыши, и выбрать за автора значило
// бы время от времени молча открывать запись там, где человек занят.
export type DrawKind = 'hours' | 'busy'

export type DrawRequest = {
  dates: string[]
  window: TimeWindow
}

export function DrawDialog({
  request,
  onClose,
  onHours,
  onBusy,
}: {
  // request — что выделено: даты (протяжка на соседнюю колонку даёт прямоугольник —
  // те же часы на каждом задетом дне) и часы.
  request: DrawRequest | null
  onClose: () => void
  // onHours — часы приёма. `weekly` = «каждый вторник», `date` = «только 16-го».
  onHours: (request: DrawRequest, scope: 'weekly' | 'date') => void
  onBusy: (request: DrawRequest, note: string) => void
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {/* ⚠ КЛЮЧ ПО САМОМУ ЖЕСТУ. Каждая протяжка обязана начинаться с чистого окна:
            подпись прошлой блокировки и объём прошлого правила, доставшиеся новому
            жесту по наследству, — это ответ за автора на вопрос, который ему не
            задавали. Ключ пересобирает форму вместо сброса полей эффектом: setState
            из эффекта запрещён линтом и стоит лишнего круга отрисовки. */}
        {request && (
          <DrawForm
            key={`${request.dates.join()}:${request.window.from}-${request.window.to}`}
            request={request}
            onClose={onClose}
            onHours={onHours}
            onBusy={onBusy}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function DrawForm({
  request,
  onClose,
  onHours,
  onBusy,
}: {
  request: DrawRequest
  onClose: () => void
  onHours: (request: DrawRequest, scope: 'weekly' | 'date') => void
  onBusy: (request: DrawRequest, note: string) => void
}) {
  const [tab, setTab] = useState<DrawKind>('hours')
  const [scope, setScope] = useState<'weekly' | 'date'>('weekly')
  const [note, setNote] = useState('')

  return (
    <>
      <DialogHeader>
        <DialogTitle>Что это за время?</DialogTitle>
        <DialogDescription>
          {datesLabel(request.dates)}, {request.window.from} — {request.window.to}
        </DialogDescription>
      </DialogHeader>

      <Tabs value={tab} onValueChange={(v) => setTab(v as DrawKind)}>
        {/* Слова табов — те же, что в легенде полотна: один слой не должен
                  называться в двух местах по-разному. */}
        <TabsList className="w-full">
          <TabsTrigger value="hours">Время работы</TabsTrigger>
          <TabsTrigger value="busy">Занятое время</TabsTrigger>
        </TabsList>

        <TabsContent value="hours" className="flex flex-col gap-3 pt-3">
          <p className="text-sm text-muted-foreground">В это время можно записаться через форму.</p>
          <div className="flex flex-col gap-2">
            <Label>Это правило действует</Label>
            <div className="flex flex-wrap gap-1">
              <Button
                type="button"
                size="sm"
                variant={scope === 'weekly' ? 'default' : 'outline'}
                onClick={() => setScope('weekly')}
              >
                {everyLabel(request.dates)}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={scope === 'date' ? 'default' : 'outline'}
                onClick={() => setScope('date')}
              >
                {onlyLabel(request.dates)}
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="busy" className="flex flex-col gap-3 pt-3">
          <p className="text-sm text-muted-foreground">
            В это время записаться нельзя. Объёма у занятости нет: это точки на оси времени, а не
            правило недели.
          </p>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sc-busy-note">Подпись</Label>
            <Input
              id="sc-busy-note"
              value={note}
              maxLength={MAX_SCHEDULE_NOTE_LEN}
              placeholder="отпуск, обед, приём в другом месте"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </TabsContent>
      </Tabs>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button
          onClick={() => (tab === 'hours' ? onHours(request, scope) : onBusy(request, note.trim()))}
        >
          {tab === 'hours' ? 'Открыть приём' : 'Закрыть время'}
        </Button>
      </DialogFooter>
    </>
  )
}
