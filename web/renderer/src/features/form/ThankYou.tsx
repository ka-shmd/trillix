import { useEffect, useState } from 'react'

import { type Block, DEFAULT_THANK_YOU_TITLE } from '@entities/formSchema'

import { BlockField } from '@fields/BlockField'
import { groupBlocks, packGroupRows, packRows } from '@fields/groups'
import { pageClass } from '@fields/pageChrome'

import { Badge } from '@fields/Badge'
import { type HostBridge } from './embed'
import { planThankYou } from './thankYouPlan'

// Экран «после отправки». Два вида одного экрана, и выбирает между ними автор:
//
//   • СТРАНИЦА «СПАСИБО» на полотне (2026-08-21) — последняя страница документа, чей
//     разрыв помечен флагом. Тогда экран это её блоки, и автор собирал его теми же
//     заголовками, абзацами и картинками, что и саму форму;
//   • иначе — заглушка с текстом из настроек формы (thankYouText). Форма без страницы
//     «Спасибо» обязана что-то показать: молчаливый пустой экран после отправки читается
//     как сбой.
//
// Поля берутся из схемы ТОЙ версии, по которой респондент отправил ответ (схема
// снапшотится при публикации), поэтому правка настроек владельцем задним числом этот
// экран не меняет. Всё решение про переход (уходить ли и когда) — в чистой planThankYou;
// здесь только рендер.
//
// Текст владельца рендерится как текст: React экранирует, dangerouslySetInnerHTML в
// репозитории запрещён (инвариант 4).
export function ThankYou({
  blocks,
  text,
  redirectUrl,
  bridge,
  badge,
  preview = false,
}: {
  /** Блоки страницы «Спасибо»; null — её нет, показываем заглушку с text. */
  blocks: Block[] | null
  text: string
  redirectUrl: string
  bridge: HostBridge | null
  /** Бейдж площадки: решение сервера, то же, что на самой форме. */
  badge: boolean
  /** Предпросмотр вставки: экран настоящий, но ответа не было — говорим об этом. */
  preview?: boolean
}) {
  const { message, target, delayMs } = planThankYou(text, redirectUrl, blocks !== null)
  // Ссылка-запасной путь показывается, когда переход уже запущен: если он не
  // случится (заблокирован в iframe, вкладка в фоне), человек не окажется в тупике.
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    if (!target) return
    // ВО ФРЕЙМЕ (фаза 20) переход делает хост: window.location внутри фрейма увёл бы
    // человека в сайт внутри сайта, оставив на чужой странице чужую шапку вокруг.
    // Послушался ли хост, нам не сообщают, поэтому запасную ссылку показываем сразу —
    // владелец сайта мог поставить data-redirect="frame" или не подключить скрипт вовсе.
    const go = bridge
      ? () => {
          setStalled(true)
          bridge.redirect(target)
        }
      : () => window.location.assign(target)
    if (delayMs === 0) {
      go()
      return
    }
    const timer = setTimeout(() => {
      setStalled(true)
      go()
    }, delayMs)
    return () => clearTimeout(timer)
  }, [target, delayMs, bridge])

  // Приписки под содержимым — общие для обоих видов экрана: и переход, и предупреждение
  // предпросмотра, и бейдж площадки про сам экран, а не про то, чем он наполнен.
  const notes = (
    <>
      {target && (
        <p className="status-detail">
          {stalled ? <a href={target}>Перейти на сайт</a> : 'Сейчас перенаправим…'}
        </p>
      )}
      {/* Формулировка «так выглядит» намеренная: текст благодарности автора стоит
          строкой выше и обычно сообщает, что ответ отправлен, — приписка «ответ не
          отправлен» рядом с ним читалась бы как спор двух строк на одном экране. */}
      {preview && (
        <p className="status-detail">
          Предпросмотр: так выглядит экран после отправки — сам ответ никуда не ушёл.
        </p>
      )}
      {badge && <Badge />}
    </>
  )

  if (blocks !== null) {
    // Страница «Спасибо» — обычная страница формы: тот же холст .rf-page и тот же ритм
    // .rf-form, что у вопросов. ХРОМА (обложка, логотип, h1) на ней нет по тому же
    // правилу, что и на второй странице формы: он только на первой (решение владельца
    // 2026-08-05).
    return (
      <main className={pageClass(undefined)}>
        <div className="rf-form">
          <BlockRows blocks={blocks} />
        </div>
        {notes}
      </main>
    )
  }

  return (
    <main className="status">
      <h1 className="status-title">{DEFAULT_THANK_YOU_TITLE}</h1>
      <p className="status-detail">{message}</p>
      {notes}
    </main>
  )
}

// BlockRows — блоки страницы в рядах и группах, БЕЗ обвязки ответа: полей на действующей
// странице «Спасибо» не бывает по построению (стоит там вопрос — флаг инертен, и это
// обычная страница), поэтому ни value, ни onChange, ни ошибок здесь нет.
//
// Свой обход, а не общий с FormView: тот тянет за собой ответы, ошибки, блокировку и
// репортёр фокуса — шесть пропов на блок, ни один из которых здесь не существует.
// Раскладчик при этом ОБЩИЙ (packRows/packGroupRows), поэтому ряды и колонки на этом
// экране считаются теми же правилами, что на любой странице формы.
function BlockRows({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {packRows(groupBlocks(blocks)).map((row) => {
        const renderGroup = (group: { id: string; blocks: Block[] }) => (
          <div key={group.id} className="rf-group">
            {packGroupRows(group.blocks).map((innerRow) =>
              innerRow.length > 1 ? (
                <div key={innerRow[0]![0]!.id} className="rf-row">
                  {innerRow.map((cell) => (
                    <div key={cell[0]!.id} className="rf-cell">
                      {cell.map((b) => (
                        <BlockField key={b.id} block={b} />
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <BlockField key={innerRow[0]![0]!.id} block={innerRow[0]![0]!} />
              ),
            )}
          </div>
        )
        const first = row[0]?.[0]
        if (!first) return null
        return row.length > 1 ? (
          <div key={first.id} className="rf-row">
            {row.map((cell) => (
              <div key={cell[0]!.id} className="rf-cell">
                {cell.map(renderGroup)}
              </div>
            ))}
          </div>
        ) : (
          renderGroup(first)
        )
      })}
    </>
  )
}
