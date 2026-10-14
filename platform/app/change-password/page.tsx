import { requirePage } from '@/server/auth/page'
import { ChangePasswordForm } from '@/ui/shell/AuthForms'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Change password · Grand Hyatt Staff Accommodation' }

export default async function ChangePasswordPage() {
  const cur = await requirePage(undefined, { allowMustChange: true })
  return <ChangePasswordForm forced={cur.mustChangePassword} />
}
