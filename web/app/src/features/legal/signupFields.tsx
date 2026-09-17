import { useId } from 'react'

import {
  SIGNUP_INDUSTRIES,
  SIGNUP_OCCUPATIONS,
  SIGNUP_POSITIONS,
  SIGNUP_PURPOSES,
  SIGNUP_REFERRALS,
  type SignupDraft,
  type SignupKind,
} from '../../entities/legal'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

// Поля анкеты регистрации — одни и те же на экране «Поделитесь парой деталей» и в окне
// правки на странице «Аккаунт» (docs/design/signup-consent.md §3.3): вопросы, их порядок и
// подписи не должны разъезжаться между двумя местами.

// NONE — значение пункта «Не указано» в списке. Пустая строка значением SelectItem быть не
// может (Radix её запрещает), а очистить ответ человек должен уметь: на странице аккаунта он
// правит и убирает то, что указал при регистрации.
const NONE = '__none__'

export function SignupFields({
  draft,
  onChange,
}: {
  draft: SignupDraft
  onChange: (draft: SignupDraft) => void
}) {
  const set = <K extends keyof SignupDraft>(key: K, value: SignupDraft[K]) =>
    onChange({ ...draft, [key]: value })

  return (
    <div className="flex flex-col gap-5 sm:gap-4">
      <KindRow value={draft.kind} onChange={(kind) => set('kind', kind)} />

      <TextRow
        label="Ваше полное имя"
        placeholder="Например, Иванов Иван Иванович"
        value={draft.fullName}
        onChange={(v) => set('fullName', v)}
        maxLength={200}
      />

      {draft.kind === 'person' ? (
        <>
          <SelectRow
            label="Чем вы занимаетесь?"
            options={SIGNUP_OCCUPATIONS}
            value={draft.occupation}
            onChange={(v) => set('occupation', v)}
          />
          <TextRow
            label="Ваша профессия"
            placeholder="Например, дизайнер"
            value={draft.profession}
            onChange={(v) => set('profession', v)}
            maxLength={100}
          />
        </>
      ) : (
        <>
          <TextRow
            label="Название организации или ИП"
            placeholder="Например, ООО «Ромашка»"
            value={draft.companyName}
            onChange={(v) => set('companyName', v)}
            maxLength={300}
          />
          <SelectRow
            label="Сфера деятельности"
            options={SIGNUP_INDUSTRIES}
            value={draft.industry}
            onChange={(v) => set('industry', v)}
          />
          <SelectRow
            label="Ваша должность"
            options={SIGNUP_POSITIONS}
            value={draft.jobPosition}
            onChange={(v) => set('jobPosition', v)}
          />
        </>
      )}

      <SelectRow
        label="Как вы о нас узнали?"
        options={SIGNUP_REFERRALS}
        value={draft.referral}
        onChange={(v) => set('referral', v)}
      />
      <SelectRow
        label="Для чего вы будете использовать Trillix?"
        options={SIGNUP_PURPOSES}
        value={draft.purpose}
        onChange={(v) => set('purpose', v)}
      />
    </div>
  )
}

// Row — строка анкеты: подпись слева, поле справа, как на образце; колонки одной ширины у всех
// строк. На узком экране подпись уходит над полем и стоит к нему ближе, чем к соседнему
// вопросу — иначе пары «подпись — поле» не читаются.
function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-2 sm:grid-cols-2 sm:items-center sm:gap-6">{children}</div>
}

function KindRow({ value, onChange }: { value: SignupKind; onChange: (v: SignupKind) => void }) {
  const labelId = useId()
  return (
    <Row>
      <span id={labelId} className="text-sm font-semibold">
        Кто вы на нашем сервисе?
      </span>
      <Tabs value={value} onValueChange={(v) => onChange(v === 'company' ? 'company' : 'person')}>
        <TabsList aria-labelledby={labelId} className="grid w-full grid-cols-2">
          <TabsTrigger value="person">Частное лицо</TabsTrigger>
          <TabsTrigger value="company">Компания или ИП</TabsTrigger>
        </TabsList>
      </Tabs>
    </Row>
  )
}

function TextRow({
  label,
  placeholder,
  value,
  onChange,
  maxLength,
}: {
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  maxLength: number
}) {
  const id = useId()
  return (
    <Row>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
    </Row>
  )
}

function SelectRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly { value: T; label: string }[]
  value: T | null
  onChange: (v: T | null) => void
}) {
  const id = useId()
  return (
    <Row>
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? NONE}
        onValueChange={(v) => onChange(options.find((o) => o.value === v)?.value ?? null)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Выберите из списка" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Не указано</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  )
}
