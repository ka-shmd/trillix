import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { FileText, Search } from 'lucide-react'

import { displayFormName } from '../../entities/form'
import { formsSearchQueryOptions } from './queries'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'

// Поиск формы ПО ВСЕМ пространствам — единственный экран кабинета, который не
// принадлежит пространству, и это его смысл: формы адресуются через пространство, а
// человек ищет ровно тогда, когда не помнит, в каком из них форма.
//
// ОКНО, А НЕ СТРОКА В ВЕРХНЕМ БАРЕ. Бар занят: слева путь, справа действия экрана
// (у формы там кластер участников, «Копировать ссылку» и «Редактировать»), и поле
// посередине отбирало бы у них ширину на каждом экране ради того, чем пользуются
// изредка. Строка в панели с подписью ⌘K стоит одну строку и находится глазами.
//
// Фильтрация ОТКЛЮЧЕНА у cmdk (`shouldFilter={false}`): совпадение ищет сервер по
// всем пространствам, а второе просеивание тех же строк на клиенте выбрасывало бы
// найденное по правилам, которых человек не видит.
export function FormSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const found = useQuery(formsSearchQueryOptions(query))

  // ⌘K / Ctrl+K — открыть откуда угодно. Слушатель на документе, а не на строке
  // панели: панель бывает свёрнута в полосу значков и закрыта шторкой на мобильном,
  // а сочетание обязано работать одинаково везде.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      setOpen((prev) => !prev)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const hits = found.data?.forms ?? []
  const asked = query.trim() !== ''

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={() => setOpen(true)} tooltip="Поиск форм">
          <Search className="size-4" />
          <span>Поиск</span>
          {/* Подпись сочетания — единственный способ о нём узнать. Прячется вместе
              с текстом в свёрнутой полосе. */}
          <kbd className="ml-auto text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            ⌘K
          </kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>

      <CommandDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          // Набранное не переживает закрытие: следующее открытие должно начинаться
          // с чистого поля, а не с прошлого запроса.
          if (!next) setQuery('')
        }}
        title="Поиск форм"
        description="Поиск формы по всем пространствам, где вы состоите"
        shouldFilter={false}
      >
        <CommandInput placeholder="Название формы…" value={query} onValueChange={setQuery} />
        <CommandList>
          {!asked && (
            <CommandEmpty>
              Начните набирать название — искать будем во всех пространствах.
            </CommandEmpty>
          )}
          {asked && found.isPending && <CommandEmpty>Ищем…</CommandEmpty>}
          {asked && found.isError && <CommandEmpty>Не удалось выполнить поиск.</CommandEmpty>}
          {asked && !found.isPending && !found.isError && hits.length === 0 && (
            <CommandEmpty>Ничего не нашлось. Попробуйте другое слово.</CommandEmpty>
          )}
          {hits.length > 0 && (
            <CommandGroup>
              {hits.map((f) => (
                <CommandItem key={f.id} value={f.id} asChild onSelect={() => setOpen(false)}>
                  {/* Куда ведёт результат — то же правило, что у карточки списка:
                      черновик в редактор (показывать ему пустые табы незачем),
                      розданную форму на ответы. Редактор адресуется через
                      пространство, поэтому slug места приезжает в самой строке. */}
                  <Link
                    {...(f.status === 'draft'
                      ? {
                          to: '/w/$workspaceSlug/forms/$slug/edit' as const,
                          params: { workspaceSlug: f.workspaceSlug, slug: f.slug },
                        }
                      : { to: '/forms/$slug/responses' as const, params: { slug: f.slug } })}
                  >
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{displayFormName(f)}</span>
                    {/* ГДЕ ЛЕЖИТ — не украшение: две одинаково названные формы в
                        разных пространствах различает только это. */}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {f.workspaceName}
                    </span>
                  </Link>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  )
}
