import { admin, call, grantCapability, makeUser, newSite, signIn, uniq, type TestUser } from '../harness'
import type { Capability, Role } from '@/domain/enums'
import { GET as list, POST as create } from '../../../app/api/v1/staff/route'
import { GET as me } from '../../../app/api/v1/staff/me/route'
import { GET as get, PATCH as patch } from '../../../app/api/v1/staff/[id]/route'
import { POST as archive } from '../../../app/api/v1/staff/[id]/archive/route'
import { POST as preview } from '../../../app/api/v1/staff/import/preview/route'
import { GET as batchGet } from '../../../app/api/v1/staff/import/[batchId]/route'
import { POST as confirm } from '../../../app/api/v1/staff/import/[batchId]/confirm/route'
import { GET as rejected } from '../../../app/api/v1/staff/import/[batchId]/rejected.csv/route'

export interface Person { user: TestUser; cookie: string }

/** A signed-in person in one role (site-scoped unless SA/Res), optionally with a capability grant. */
export async function person(role: Role, o: { siteId?: string; caps?: Capability[] } = {}): Promise<Person> {
  const siteId = o.siteId ?? (await newSite())
  const user = await makeUser({ roles: [role === 'SA' ? { role, all: true } : role === 'Res' ? { role } : { role, siteId }] })
  for (const c of o.caps ?? []) await grantCapability(user.id, c)
  return { user, cookie: await signIn(user) }
}

export const api = {
  list: (p: Person, query = '') => call(list, { method: 'GET', path: `/api/v1/staff${query}`, cookie: p.cookie }),
  create: (p: Person, body: unknown) => call(create, { method: 'POST', path: '/api/v1/staff', body, cookie: p.cookie }),
  me: (p: Person) => call(me, { method: 'GET', path: '/api/v1/staff/me', cookie: p.cookie }),
  get: (p: Person, id: string) => call(get, { method: 'GET', path: `/api/v1/staff/${id}`, cookie: p.cookie, params: { id } }),
  patch: (p: Person, id: string, body: unknown) => call(patch, { method: 'PATCH', path: `/api/v1/staff/${id}`, body, cookie: p.cookie, params: { id } }),
  archive: (p: Person, id: string, body: unknown = { reason: 'Test archive' }) => call(archive, { method: 'POST', path: `/api/v1/staff/${id}/archive`, body, cookie: p.cookie, params: { id } }),
  preview: (p: Person, csv: string, fileName?: string) => call(preview, { method: 'POST', path: '/api/v1/staff/import/preview', body: { csv, fileName }, cookie: p.cookie }),
  batch: (p: Person, batchId: string) => call(batchGet, { method: 'GET', path: `/api/v1/staff/import/${batchId}`, cookie: p.cookie, params: { batchId } }),
  confirm: (p: Person, batchId: string) => call(confirm, { method: 'POST', path: `/api/v1/staff/import/${batchId}/confirm`, body: {}, cookie: p.cookie, params: { batchId } }),
  rejected: async (p: Person, batchId: string) => {
    const res = await rejected(new Request(`http://localhost:3000/api/v1/staff/import/${batchId}/rejected.csv`, { headers: { host: 'localhost:3000', cookie: p.cookie } }), { params: { batchId } })
    // Keep the byte-order mark (Response.text() would drop it) so the test sees exactly what a browser saves.
    return { status: res.status, headers: res.headers, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer()) }
  },
}

/** A staff profile written straight to the database (as the superuser), with full details. */
export async function seedStaff(o: { employeeId?: string; fullName?: string; department?: string } = {}) {
  const employeeId = o.employeeId ?? uniq('T')
  const r = await admin().query<{ id: string }>(
    `INSERT INTO staff_profile (employee_id, full_name, gender, department, grade, phone, email, emergency_contact, joining_date)
     VALUES ($1, $2, 'female', $3, 4, '+971501234567', 'secret.person@example.com', 'Mother 0509998888', '2026-01-05') RETURNING id`,
    [employeeId, o.fullName ?? 'Secret Person', o.department ?? 'Spa'])
  return { id: r.rows[0].id, employeeId }
}

export const countStaff = async (employeeId: string) =>
  Number((await admin().query(`SELECT count(*) FROM staff_profile WHERE lower(btrim(employee_id)) = lower(btrim($1))`, [employeeId])).rows[0].count)

export const auditRows = async (action: string, entityId?: string) =>
  (await admin().query(`SELECT * FROM audit_event WHERE action = $1 ${entityId ? 'AND entity_id = $2' : ''} ORDER BY seq`, entityId ? [action, entityId] : [action])).rows

export const csvOf = (...lines: string[]) => lines.join('\n')
export const HEADER = 'employee_id,full_name,gender,department,grade,phone,email,joining_date,employment_status,emergency_contact_name,emergency_contact_phone'
