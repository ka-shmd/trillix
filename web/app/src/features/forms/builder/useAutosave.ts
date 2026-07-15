import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { type StoreApi } from 'zustand/vanilla'

import { ApiError } from '../../../shared/api/errors'
import { type FormDetail } from '../../../entities/form'
import { formKeys } from '../keys'
import { saveDraftSchema } from './api'
import { type BuilderStore } from './store'

export type SaveStatus = 'saved' | 'saving' | 'error' | 'conflict'

const DEBOUNCE_MS = 800

// formLockToken — токен оптимистичной блокировки (updated_at формы). Единый
// источник — кэш detail в Query: его двигают ВСЕ мутации, меняющие форму (автосейв
// схемы, переименование заголовка, публикация). Читать токен отсюда, а не из
// приватного ref, — иначе после rename автосейв ушлёт устаревший updatedAt и словит
// 409 «Форма изменена в другой вкладке», хотя вкладка одна. Ключ кэша detail —
// slug формы (идентификатор URL кабинета), а не UUID.
export function formLockToken(
  qc: ReturnType<typeof useQueryClient>,
  slug: string,
  fallback: string,
): string {
  return qc.getQueryData<FormDetail>(formKeys.detail(slug))?.updatedAt ?? fallback
}

// useAutosave связывает стор билдера с бэкендом: правки документа (dirty) через
// дебаунс уходят в PATCH всей схемы. updatedAt-токен оптимистичной блокировки
// читается из кэша detail (formLockToken) и обновляется там ответом каждого
// сохранения. Конфликт (409) переводит в терминальный статус 'conflict' — дальше
// молчим, пользователь перезагружает.
//
// formId (UUID) — цель самого PATCH /forms/{id}; slug — ключ кэша detail (по нему
// адресована форма в URL кабинета). Возвращает статус для индикатора и retry.
export function useAutosave(
  store: StoreApi<BuilderStore>,
  formId: string,
  slug: string,
  initialUpdatedAt: string,
) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<SaveStatus>('saved')

  // Всё «живое» — в ref: колбэки подписки/таймера не пересоздаются и не тянут
  // перезапуск эффекта. runRef держит актуальную функцию сохранения для retry.
  const savingRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conflictRef = useRef(false)
  const runRef = useRef<() => void>(() => {})

  // initialUpdatedAt — только фолбэк токена блокировки (реальный берётся из кэша),
  // поэтому держим его в ref и НЕ кладём в зависимости основного эффекта. Иначе rename
  // заголовка (двигает updatedAt в detail-кэше → новый проп) пересоздавал бы эффект, а
  // его cleanup гасил бы незавершённый дебаунс автосейва схемы — правка молча терялась,
  // «Опубликовать» залипала disabled. Ref синхронизируется отдельным эффектом.
  const initialUpdatedAtRef = useRef(initialUpdatedAt)
  useEffect(() => {
    initialUpdatedAtRef.current = initialUpdatedAt
  }, [initialUpdatedAt])

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const schedule = () => {
      clearTimer()
      timerRef.current = setTimeout(() => void run(), DEBOUNCE_MS)
    }

    async function run() {
      // Уже сохраняем или конфликт — не наслаиваемся; finally сам перепланирует,
      // если правки остались.
      if (savingRef.current || conflictRef.current) return
      if (!store.getState().dirty) {
        setStatus('saved')
        return
      }

      savingRef.current = true
      setStatus('saving')
      const snapshot = store.getState().toSchema()
      const snapshotJson = JSON.stringify(snapshot)
      let ok = false
      try {
        // Токен блокировки — свежий из кэша: если между дебаунсами прошёл rename
        // заголовка, он уже подвинул updatedAt в detail, и мы не отправим устаревший.
        const form = await saveDraftSchema(
          formId,
          snapshot,
          formLockToken(qc, slug, initialUpdatedAtRef.current),
        )
        ok = true
        // Список форм сортируется по updatedAt — он изменился; detail патчим, чтобы
        // повторный вход в форму гидрировал стор сохранённым состоянием и токеном.
        qc.invalidateQueries({ queryKey: formKeys.list() })
        qc.setQueryData<FormDetail>(formKeys.detail(slug), (old) =>
          old
            ? {
                ...old,
                updatedAt: form.updatedAt,
                draftSchema: snapshot,
                // Правка черновика опубликованной формы разводит его с версией →
                // бейдж «есть неопубликованные изменения» (у черновика остаётся false).
                hasUnpublishedChanges: old.publishedVersionId !== null,
              }
            : old,
        )
        // Отмечаем сохранённым, только если за время запроса не появилось новых
        // правок — иначе dirty остаётся и finally перепланирует сохранение.
        if (JSON.stringify(store.getState().toSchema()) === snapshotJson) {
          store.getState().markSaved()
          setStatus('saved')
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'conflict') {
          conflictRef.current = true
          setStatus('conflict')
        } else {
          setStatus('error')
        }
      } finally {
        savingRef.current = false
        // Правки во время удачного запроса — сохранить ещё раз. После ошибки/конфликта
        // авто-цикл не крутим (ретрай — вручную, конфликт — перезагрузкой).
        if (ok && store.getState().dirty) schedule()
      }
    }

    runRef.current = () => {
      void run()
    }

    // Дебаунс на изменения документа: перемещение/правка меняют ссылку blocks,
    // правка текста кнопки — submitLabel; выбор блока (selectedId) документ не
    // трогает и сохранение не будит.
    const unsub = store.subscribe((state, prev) => {
      const changed = state.blocks !== prev.blocks || state.submitLabel !== prev.submitLabel
      if (changed && !conflictRef.current) schedule()
    })

    return () => {
      unsub()
      clearTimer()
    }
    // initialUpdatedAt намеренно НЕ в зависимостях — см. initialUpdatedAtRef выше:
    // его смена (rename заголовка) не должна пересоздавать эффект и гасить дебаунс.
  }, [store, formId, slug, qc])

  // Предупреждение при уходе с несохранёнными правками (в т.ч. пока идёт сохранение).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (store.getState().dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [store])

  // Ручной повтор после статуса 'error' — тот же путь сохранения, без дебаунса.
  const retry = () => runRef.current()

  return { status, retry }
}
