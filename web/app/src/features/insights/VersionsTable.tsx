import { type VersionStat } from '../../entities/versionStats'
import { conversionText } from './metrics'
import { formatDate, formatDuration } from '../../shared/format'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// Разрез по версиям формы: помогла ли правка — видно сравнением строк. Свежие версии
// сверху (так их отдаёт сервер), версий без визитов в окне нет.
export function VersionsTable({ versions }: { versions: VersionStat[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Версия</TableHead>
          <TableHead>Опубликована</TableHead>
          <TableHead className="text-right">Визиты</TableHead>
          <TableHead className="text-right">Отправили</TableHead>
          <TableHead className="text-right">Заполнение</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.map((v) => (
          <TableRow key={v.number}>
            <TableCell className="font-medium">{v.number}</TableCell>
            <TableCell className="text-muted-foreground">{formatDate(v.publishedAt)}</TableCell>
            <TableCell className="text-right tabular-nums">{v.visits}</TableCell>
            <TableCell className="text-right tabular-nums">{conversionText(v.submitted, v.visits)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {v.timedCompletions > 0 ? formatDuration(v.completionDurationSec) : '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
