'use client'
import { useRouter } from 'next/navigation'
import { Button } from '@/ui'
import { post } from '@/ui/api'

export function MarkAllRead() {
  const router = useRouter()
  return <Button onClick={async () => { await post('/api/v1/notifications/read'); router.refresh() }}>Mark all read</Button>
}
