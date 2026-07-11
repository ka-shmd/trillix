import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { CredentialsForm } from '../../features/auth/CredentialsForm'
import { useRegister } from '../../features/auth/queries'

export const Route = createFileRoute('/_auth/register')({
  component: RegisterPage,
})

function RegisterPage() {
  const navigate = useNavigate()
  const mutation = useRegister()

  return (
    <>
      <h1>Регистрация</h1>
      <CredentialsForm
        submitLabel="Создать аккаунт"
        pending={mutation.isPending}
        serverError={mutation.error}
        onSubmit={(creds) => mutation.mutate(creds, { onSuccess: () => navigate({ to: '/' }) })}
      />
      <p className="auth-switch">
        Уже есть аккаунт? <Link to="/login">Вход</Link>
      </p>
    </>
  )
}
