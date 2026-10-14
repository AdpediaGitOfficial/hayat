import { redirect } from 'next/navigation'
import { maybeUser } from '@/server/auth/page'
import { LoginForm } from '@/ui/shell/AuthForms'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Sign in · Grand Hyatt Staff Accommodation' }

export default async function LoginPage() {
  if (await maybeUser()) redirect('/')
  return <LoginForm />
}
