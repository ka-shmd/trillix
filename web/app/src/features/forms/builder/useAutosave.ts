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

// useAutosave связывает стор билдера с бэкендом: правки документа (dirty) через
// дебаунс уходят в PATCH всей схемы. updatedAt-токен хранится в ref и обновляется
// ответом каждого сохранения (оптимистичная блокировка). Конфликт (409) переводит
// в терминальный статус 'conflict' — дальше молчим, пользователь перезагружает.
//
// Возвращает статус для индикатора и retry для ручного повтора после ошибки.
export function useAutosave(store: StoreApi<BuilderStore>, formId: string, initialUpdatedAt: string) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<SaveStatus>('saved')

  // Всё «живое» — в ref: колбэки подписки/таймера не пересоздаются и не тянут
  // перезапуск эффекта. runRef держит актуальную функцию сохранения для retry.
  const updatedAtRef = useRef(initialUpdatedAt)
  const savingRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const conflictRef = useRef(false)
  const runRef = useRef<() => void>(() => {})

  useEffect(() => {
    updatedAtRef.current = initialUpdatedAt

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
        const form = await saveDraftSchema(formId, snapshot, updatedAtRef.current)
        updatedAtRef.current = form.updatedAt
        ok = true
        // Список форм сортируется по updatedAt — он изменился; detail патчим, чтобы
        // повторный вход в форму гидрировал стор сохранённым состоянием и токеном.
        qc.invalidateQueries({ queryKey: formKeys.list() })
        qc.setQueryData<FormDetail>(formKeys.detail(formId), (old) =>
          old ? { ...old, updatedAt: form.updatedAt, draftSchema: snapshot } : old,
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

    // Дебаунс на изменения документа: перемещение/правка меняют ссылку blocks;
    // выбор блока (selectedId) документ не трогает и сохранение не будит.
    const unsub = store.subscribe((state, prev) => {
      if (state.blocks !== prev.blocks && !conflictRef.current) schedule()
    })

    return () => {
      unsub()
      clearTimer()
    }
  }, [store, formId, initialUpdatedAt, qc])

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
