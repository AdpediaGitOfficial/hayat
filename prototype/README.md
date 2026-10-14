# Grand Hyatt Staff Accommodation: clickable prototype (Step 0)

Next.js 14 (App Router) + React 18 + TypeScript. **Dummy data, in-memory state, a demo clock, no backend, no real auth or notifications** (D-97 to D-100). Business rules run for real in `src/domain/store.ts`, so approvals, allocation conflicts, timers and escalations behave as specified.

```bash
cd prototype
npm install
npm run dev        # http://localhost:3000, pick a role on the landing page
npm test           # 25 scenario tests against the real store
npm run build
```

Design tokens and components follow `docs/design/GrandHyatt-Design-System.html` (red brand `#C42737`, glass cards, solid ink sidebar, Jost + Inter, Lucide icons, light and dark).

## Try it
Switch role from the sidebar (top-left or the user footer). The **demo clock** at the bottom jumps time forward; **Reset data** restores the seed and the clock.

| Flow | Role | Where | What to try |
|---|---|---|---|
| 1 Dashboards | any | Dashboard | Each role has its own home. Residents see a status-based home (none, applied, waitlisted, offered, reserved, staying, checking out). |
| 2 Bed inventory | Anita (AA) | Sites and rooms | Site tabs, state filters, bed drawer. Villa is Site › Building › Room › Bed; Lakeview is Site › Room › Bed. Try Archive on an occupied bed. |
| 3 Request → approval → check-in | Anita, then Rohan | Approvals, then Dashboard | Review and allocate Kiran Patel (bed chosen and reserved in one step). Check in Ayesha Khan (ready) and Joseph Mathew (bed Needs cleaning, so blocked with reason + owner + next action). |
| 4 Waitlist and offers | Anita / Omar / Neha | Waitlist; Omar's home | Live 48h and 15-day timers. Offer a bed to Neha, decline twice as Neha, accept as Omar. Jump +1 day to see the 24h follow-up. |
| 5 Conflict and bulk | Anita | Allocations › Conflict lab / Bulk | Two admins confirm the same bed; the second is refused. Bulk preview, per-row results, retry-safe. |
| 6 Transfer and swap | Anita, Rohan | Approvals, Transfers | Approve, then execute. Tick "simulate a key-reissue failure" to watch a full rollback. |
| 7 Exit → bed turnover | Anita, Rohan, Lakshmi | Joiners and exits, Clearances, Housekeeping | Mark Dev Malhotra as Left (login revoked, bed still Occupied), check out, clean (Lakshmi), inspect (Rohan). Bed is never Available before that. Suresh can waive clearance items. |
| 8 Emergency check-in | Rohan, Anita, Suresh | Emergency check-in | Jump +1 day twice and watch reminders then escalation. It never auto-approves. |
| 9 Onboarding and migration | Anita, Suresh | Staff directory | Add staff (duplicate ID rejected), CSV preview with the sample, Import Current Occupancy (maker-checker). |

## Layout
```
src/domain/    types, seed data, rules (eligibility, overlap, permissions), store (atomic actions), selectors, demo clock
src/ui/        design-system components (Button, Badge, GlassCard, StatTile, DataTable, …)
src/screens/   one file per module
src/app/       Next.js routes: / (role picker), /[persona]/[page]
tests/         scenario tests mapped to the non-negotiable invariants
```

Every store action runs on a clone and commits only if it fully succeeds, which gives the atomic behaviour required for reservation, check-in, transfer, swap and checkout.

## Assumptions made (not yet decided by Grand Hyatt)
- Eligibility rules are placeholders (gender per room; Marina Apartments needs grade G4+). Open: GH-03.
- Working week is Mon to Fri for business-day SLAs.
- An offer that expires unanswered releases the bed and leaves the resident on the waitlist (not counted as a decline).
- After a second decline the decline counter resets while the entry goes to the back of the queue.
- Extension "within policy" is up to 90 days beyond the current end date.
