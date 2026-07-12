import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { CredentialsForm } from '../../features/auth/CredentialsForm'
import { useLogin } from '../../features/auth/queries'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export const Route = createFileRoute('/_auth/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const mutation = useLogin()

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Вход</CardTitle>
        <CardDescription>Войдите в свой аккаунт Trierra</CardDescription>
      </CardHeader>
      <CardContent>
        <CredentialsForm
          submitLabel="Войти"
          pending={mutation.isPending}
          serverError={mutation.error}
          onSubmit={(creds) => mutation.mutate(creds, { onSuccess: () => navigate({ to: '/' }) })}
        />
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">
          Нет аккаунта?{' '}
          <Link to="/register" className="text-primary underline-offset-4 hover:underline">
            Регистрация
          </Link>
        </p>
      </CardFooter>
    </Card>
  )
}
