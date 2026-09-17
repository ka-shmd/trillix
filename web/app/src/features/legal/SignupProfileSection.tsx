import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { signupProfileQueryOptions, useSaveSignupProfile } from './queries'
import { SignupFields } from './signupFields'
import {
  draftFromProfile,
  signupAnswerLabel,
  signupProfileOf,
  SIGNUP_INDUSTRIES,
  SIGNUP_KINDS,
  SIGNUP_OCCUPATIONS,
  SIGNUP_POSITIONS,
  SIGNUP_PURPOSES,
  SIGNUP_REFERRALS,
  signupProfileFilled,
  type SignupDraft,
  type SignupProfile,
} from '../../entities/legal'
import { humanError } from '../../shared/api/errors'
import { Section } from '../../shared/page/Section'
import { LoadingRows } from '../../shared/page/states'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Раздел «О вас» на странице «Аккаунт»: что человек указал при регистрации, с правкой и
// очисткой (docs/design/signup-consent.md §3.3). Анкета — его персональные данные, и он
// вправе их уточнить или убрать (ст. 14 152-ФЗ).
//
// Жанр раздела — как у соседей по странице: факты строками, действие кнопкой справа, правка в
// окне (docs/DESIGN-SYSTEM.md, решение владельца 2026-09-08). Поля в окне — те же, что на
// экране «Поделитесь парой деталей» (общий SignupFields), иначе два места разъедутся.

// rowsOf — что показать строками: вопросы текущего вида, без чужой вкладки.
function rowsOf(p: SignupProfile): { label: string; value: string | null }[] {
  const person = p.kind !== 'company'
  return [
    { label: 'Кто вы', value: signupAnswerLabel(SIGNUP_KINDS, p.kind ?? 'person') },
    { label: 'Полное имя', value: p.fullName },
    ...(person
      ? [
          { label: 'Чем занимаетесь', value: signupAnswerLabel(SIGNUP_OCCUPATIONS, p.occupation) },
          { label: 'Профессия', value: p.profession },
        ]
      : [
          { label: 'Организация или ИП', value: p.companyName },
          { label: 'Сфера деятельности', value: signupAnswerLabel(SIGNUP_INDUSTRIES, p.industry) },
          { label: 'Должность', value: signupAnswerLabel(SIGNUP_POSITIONS, p.jobPosition) },
        ]),
    { label: 'Как узнали о Trillix', value: signupAnswerLabel(SIGNUP_REFERRALS, p.referral) },
    { label: 'Для чего используете', value: signupAnswerLabel(SIGNUP_PURPOSES, p.purpose) },
  ]
}

export function SignupProfileSection() {
  const profile = useQuery(signupProfileQueryOptions)
  const [editing, setEditing] = useState(false)

  return (
    <Section
      title="О вас"
      description="Что вы указали при регистрации. Это можно исправить или очистить."
      action={
        <Button variant="outline" size="sm" disabled={!profile.data} onClick={() => setEditing(true)}>
          {signupProfileFilled(profile.data) ? 'Изменить' : 'Заполнить'}
        </Button>
      }
    >
      {profile.isPending && <LoadingRows rows={2} />}
      {profile.isError && (
        <p role="alert" className="text-sm text-destructive">
          {humanError(profile.error)}
        </p>
      )}
      {profile.data && (
        <ul className="divide-y border-t">
          {rowsOf(profile.data).map((row) => (
            <li key={row.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
              <span className="text-sm text-muted-foreground">{row.label}</span>
              {/* Пустой ответ — прочерк, а не пропущенная строка: иначе состав анкеты
                  меняется от того, что заполнено, и «чего тут не хватает» не видно. */}
              <span className="text-sm font-medium">{row.value ?? '—'}</span>
            </li>
          ))}
        </ul>
      )}
      {profile.data && (
        <EditDialog
          key={editing ? 'open' : 'closed'}
          profile={profile.data}
          open={editing}
          onOpenChange={setEditing}
        />
      )}
    </Section>
  )
}

function EditDialog({
  profile,
  open,
  onOpenChange,
}: {
  profile: SignupProfile
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // key по состоянию окна (в родителе) сбрасывает черновик на каждое открытие: закрытое
  // окно не должно помнить незаписанную правку.
  const [draft, setDraft] = useState<SignupDraft>(() => draftFromProfile(profile))
  const save = useSaveSignupProfile()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>О вас</DialogTitle>
          <DialogDescription>
            Все ответы необязательны — оставьте только то, что хотите о себе сообщить.
          </DialogDescription>
        </DialogHeader>

        <SignupFields draft={draft} onChange={setDraft} />

        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {humanError(save.error)}
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          {/* «Очистить» опустошает поля, но не сохраняет: решение записывается той же
              кнопкой, что и правка, — иначе очистка была бы необратима одним нажатием. */}
          <Button variant="ghost" onClick={() => setDraft(draftFromProfile(undefined))}>
            Очистить
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button
              disabled={save.isPending}
              onClick={() =>
                save.mutate(signupProfileOf(draft), { onSuccess: () => onOpenChange(false) })
              }
            >
              {save.isPending ? 'Сохраняем…' : 'Сохранить'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
