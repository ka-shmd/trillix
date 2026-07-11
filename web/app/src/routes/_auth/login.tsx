import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { CredentialsForm } from '../../features/auth/CredentialsForm'
import { useLogin } from '../../features/auth/queries'

export const Route = createFileRoute('/_auth/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const mutation = useLogin()

  return (
    <>
      <h1>Вход</h1>
      <CredentialsForm
        submitLabel="Войти"
        pending={mutation.isPending}
        serverError={mutation.error}
        onSubmit={(creds) => mutation.mutate(creds, { onSuccess: () => navigate({ to: '/' }) })}
      />
      <p className="auth-switch">
        Нет аккаунта? <Link to="/register">Регистрация</Link>
      </p>
    </>
  )
}
