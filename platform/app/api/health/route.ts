import { NextResponse } from 'next/server'
import { checkDb } from '@/server/db/client'

// Always evaluated per request: a cached "ok" would defeat the purpose of a health check.
export const dynamic = 'force-dynamic'

export async function GET() {
  const db = await checkDb()
  if (!db.ok) console.error('health: database check failed:', db.error)
  const body = {
    status: db.ok ? 'ok' : 'degraded',
    db: db.ok ? { status: 'up', latencyMs: db.latencyMs } : { status: 'down' },
    time: new Date().toISOString(),
  }
  return NextResponse.json(body, { status: db.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}
