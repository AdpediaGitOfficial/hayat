'use client'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { Alert, Button, Field, GlassCard, Input } from '@/ui'
import { post, type ApiFail } from '@/ui/api'

function Brand() {
  return <div className="login-brand"><span className="sb-mark" style={{ background: 'var(--brand-fill)' }}>GH</span><div><b>Grand Hyatt</b><span>Staff Accommodation</span></div></div>
}

function Problem({ f }: { f: ApiFail }) {
  return <Alert tone="danger" title={f.reason} detail={[f.owner && `Owner: ${f.owner}`, f.next && `Next: ${f.next}`].filter(Boolean).join(' · ') || undefined} />
}

export function LoginForm() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<ApiFail>()
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(undefined)
    const r = await post<{ mustChangePassword: boolean }>('/api/v1/auth/login', { username, password })
    setBusy(false)
    if (!r.ok) { setErr(r); setPassword(''); return }
    router.push(r.data.mustChangePassword ? '/change-password' : '/')
    router.refresh()
  }

  return (
    <div className="login gh-canvas">
      <GlassCard strong className="login-card">
        <Brand />
        <form className="form" onSubmit={submit} noValidate>
          <h1>Sign in</h1>
          {err && <Problem f={err} />}
          <Field label="Username" hint="Your employee ID unless told otherwise" error={err?.fields?.username}>
            <Input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoFocus required />
          </Field>
          <Field label="Password" error={err?.fields?.password}>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
          </Field>
          <Button variant="primary" type="submit" block tall disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          <p className="muted body-sm">Forgot your password? Ask your Accommodation Admin or Super Admin to reset it.</p>
        </form>
      </GlassCard>
    </div>
  )
}

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [err, setErr] = useState<ApiFail>()
  const [busy, setBusy] = useState(false)
  const mismatch = again.length > 0 && again !== next

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (next !== again) return
    setBusy(true); setErr(undefined)
    const r = await post('/api/v1/auth/change-password', { current, next })
    setBusy(false)
    if (!r.ok) return setErr(r)
    router.push('/')
    router.refresh()
  }

  return (
    <div className="login gh-canvas">
      <GlassCard strong className="login-card">
        <Brand />
        <form className="form" onSubmit={submit} noValidate>
          <h1>{forced ? 'Choose a new password' : 'Change password'}</h1>
          {forced && <Alert tone="info" title="First sign-in" detail="Replace the temporary password you were given before you continue." />}
          {err && <Problem f={err} />}
          <Field label={forced ? 'Temporary password' : 'Current password'} error={err?.fields?.current}>
            <Input type="password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" required />
          </Field>
          <Field label="New password" hint="At least 10 characters" error={err?.fields?.next}>
            <Input type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" required />
          </Field>
          <Field label="New password again" error={mismatch ? 'The two passwords differ' : undefined}>
            <Input type="password" value={again} onChange={e => setAgain(e.target.value)} autoComplete="new-password" required />
          </Field>
          <Button variant="primary" type="submit" block tall disabled={busy || !current || !next || next !== again}>{busy ? 'Saving…' : 'Save password'}</Button>
          {!forced && <Button variant="ghost" block onClick={() => router.push('/')}>Cancel</Button>}
        </form>
      </GlassCard>
    </div>
  )
}
