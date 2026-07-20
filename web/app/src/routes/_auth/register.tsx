import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { CredentialsForm } from '../../features/auth/CredentialsForm'
import { useRegister } from '../../features/auth/queries'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export const Route = createFileRoute('/_auth/register')({
  component: RegisterPage,
})

function RegisterPage() {
  const navigate = useNavigate()
  const mutation = useRegister()

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Регистрация</CardTitle>
        <CardDescription>Создайте аккаунт Trillix</CardDescription>
      </CardHeader>
      <CardContent>
        <CredentialsForm
          submitLabel="Создать аккаунт"
          pending={mutation.isPending}
          serverError={mutation.error}
          onSubmit={(creds) => mutation.mutate(creds, { onSuccess: () => navigate({ to: '/' }) })}
        />
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">
          Уже есть аккаунт?{' '}
          <Link to="/login" className="text-primary underline-offset-4 hover:underline">
            Вход
          </Link>
        </p>
      </CardFooter>
    </Card>
  )
}
