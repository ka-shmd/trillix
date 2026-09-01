import { useState } from 'react'
import { Link } from '@tanstack/react-router'

import { ApiError } from '../../../shared/api/errors'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

// Сборка формы по описанию (фаза 26). Диалог, а не поле прямо на полотне: пустое
// полотно — приглашение начать печатать, и второе поле ввода на нём соревновалось бы
// с первым за то же действие.
//
// ЗЕРКАЛО forms.MaxPromptLen (internal/forms/generate.go). Бэк проверяет длину сам и
// независимо; здесь она нужна, чтобы счётчик под полем не врал.
const MAX_PROMPT_LEN = 1000

// Пример показывается плейсхолдером, а не отдельным абзацем: он нужен ровно до
// первого символа, и текст, остающийся на экране во время набора, только сужает поле.
const PLACEHOLDER =
  'Например: анкета записи в барбершоп — имя, телефон, мастер на выбор, дата визита и согласие на обработку данных'

// Отказы различаются по КОДУ, а не по тексту (web/CLAUDE.md): текст меняется, код —
// контракт. Сообщение бэка показывается только там, где оно человеческое и говорит
// больше кода: 503 объясняет, лёг ли провайдер или модель не справилась с описанием.
function failureText(error: unknown): { text: string; showPlanLink: boolean } {
  if (!(error instanceof ApiError)) {
    return { text: 'Не удалось собрать форму. Попробуйте ещё раз.', showPlanLink: false }
  }
  switch (error.code) {
    case 'plan_required':
      return {
        text: 'Генерации на этом тарифе кончились. Счётчик обнулится первого числа.',
        showPlanLink: true,
      }
    case 'not_found':
      return {
        text: 'Сборка по описанию здесь не настроена — форму можно собрать руками или взять шаблон.',
        showPlanLink: false,
      }
    case 'rate_limited':
      return { text: 'Слишком часто. Подождите минуту и попробуйте снова.', showPlanLink: false }
    case 'unavailable':
      return { text: error.message, showPlanLink: false }
    case 'validation_failed':
      return { text: error.message, showPlanLink: false }
    default:
      return { text: 'Не удалось собрать форму. Попробуйте ещё раз.', showPlanLink: false }
  }
}

// onGenerate делает всё: запрос, инвалидацию списка и переход в редактор новой формы.
// Диалог о пространстве и маршрутах не знает — их связывает файл маршрута (импорт
// фичи из фичи запрещён, web/CLAUDE.md).
export function GenerateFormDialog({
  open,
  onOpenChange,
  onGenerate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onGenerate: (prompt: string) => Promise<void>
}) {
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const trimmed = prompt.trim()

  // Ни набранное, ни отказ не переживают закрытие: следующее открытие начинается с
  // чистого поля. Закрыть во время работы нельзя — запрос уже оплачен вызовом.
  function close() {
    if (pending) return
    setPrompt('')
    setError(null)
    onOpenChange(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (trimmed === '' || pending) return
    setPending(true)
    setError(null)
    try {
      await onGenerate(trimmed)
      setPrompt('')
      onOpenChange(false)
    } catch (err) {
      setError(err)
    } finally {
      setPending(false)
    }
  }

  const failure = error === null ? null : failureText(error)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Собрать форму по описанию</DialogTitle>
          <DialogDescription>
            Опишите форму словами — получится черновик с вопросами, который дальше правится как
            обычно.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="generate-prompt" className="mb-2 block">
              Что за форма
            </Label>
            <Textarea
              id="generate-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={PLACEHOLDER}
              maxLength={MAX_PROMPT_LEN}
              rows={4}
              autoFocus
              disabled={pending}
            />
            <p className="mt-2 text-sm text-muted-foreground">
              {pending
                ? 'Собираю форму. Обычно 15–40 секунд — окно можно не закрывать.'
                : `${prompt.length} из ${MAX_PROMPT_LEN} символов`}
            </p>
            {failure && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {failure.text}{' '}
                {failure.showPlanLink && (
                  <Link to="/settings/plan" className="underline underline-offset-2">
                    Посмотреть тариф
                  </Link>
                )}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close} disabled={pending}>
              Отмена
            </Button>
            <Button type="submit" disabled={trimmed === '' || pending}>
              {pending ? 'Собираю…' : 'Собрать форму'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
