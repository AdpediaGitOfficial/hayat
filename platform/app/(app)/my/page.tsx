import { requirePage } from '@/server/auth/page'
import { MY_SECTIONS } from '@/app-my'
import { GlassCard, PageHeader } from '@/ui'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'My accommodation · Grand Hyatt Staff Accommodation' }

export default async function MyAccommodation() {
  const cur = await requirePage()
  const sections = (await Promise.all(MY_SECTIONS.map(async s => ({ id: s.id, node: await s.render(cur) })))).filter(s => s.node)
  return (
    <>
      <PageHeader eyebrow="Resident" title="My accommodation" summary="Where your request, offer, reservation or stay stands." />
      {sections.length === 0
        ? <GlassCard title="Nothing here yet"><div className="tbl-empty">When you request a bed, your request, offers and stay will appear here.</div></GlassCard>
        : sections.map(s => <div key={s.id}>{s.node}</div>)}
    </>
  )
}
