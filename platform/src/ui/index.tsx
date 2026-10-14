'use client'

import { cloneElement, createContext, isValidElement, ReactElement, ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { Icon, IconName } from './icons'
import { fmtDur, useNow } from './time'
import { statusTone, statusLabel, type Tone } from './status'

export { Icon }
export type { IconName }

/* ---------- Button ---------- */
type BtnProps = {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'md' | 'sm'
  icon?: IconName
  children?: ReactNode
  onClick?: () => void
  disabled?: boolean
  title?: string
  block?: boolean
  tall?: boolean
  type?: 'button' | 'submit'
  'aria-label'?: string
}
export function Button({ variant = 'secondary', size = 'md', icon, children, block, tall, type = 'button', ...rest }: BtnProps) {
  const cls = ['btn', variant, size === 'sm' ? 'sm' : '', !children && icon ? 'icon-only' : '', block ? 'block' : '', tall ? 'tall' : ''].join(' ')
  return (
    <button type={type} className={cls} onClick={rest.onClick} disabled={rest.disabled} title={rest.title} aria-label={rest['aria-label']}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  )
}

/* ---------- Badge ---------- */
export function Badge({ tone = 'neutral', dot = true, outline, children, icon }: { tone?: Tone; dot?: boolean; outline?: boolean; children: ReactNode; icon?: IconName }) {
  return (
    <span className={`badge ${outline ? 'outline' : tone}`}>
      {tone === 'danger' && !outline ? <Icon name="alert" size={12} /> : icon ? <Icon name={icon} size={12} /> : dot && !outline ? <i className="dot" /> : null}
      {children}
    </span>
  )
}

/* ---------- Status ---------- */
export { statusTone }
export type { Tone }
export function Status({ s, label }: { s: string; label?: string }) {
  return <Badge tone={statusTone(s)}>{label ?? statusLabel(s)}</Badge>
}

/* ---------- Card ---------- */
export function GlassCard({ title, subtitle, eyebrow, actions, footer, strong, flush, divider, children, className = '' }: {
  title?: ReactNode; subtitle?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode; footer?: ReactNode
  strong?: boolean; flush?: boolean; divider?: boolean; children?: ReactNode; className?: string
}) {
  return (
    <section className={`card ${strong ? 'strong' : ''} ${flush ? 'flush' : ''} ${className}`}>
      {(title || actions) && (
        <header className={`card-head ${divider ? 'divider' : ''}`}>
          <div className="t">
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            {title && <h2>{title}</h2>}
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className="card-body" style={!title && !actions ? { paddingTop: 20 } : undefined}>{children}</div>}
      {footer && <footer className="card-foot">{footer}</footer>}
    </section>
  )
}

/* ---------- Sparkline ---------- */
export function Sparkline({ data, good = true, w = 88, h = 28 }: { data: number[]; good?: boolean; w?: number; h?: number }) {
  const min = Math.min(...data), max = Math.max(...data)
  const pts = data.map((v, i) => [(i / (data.length - 1)) * (w - 6) + 3, h - 4 - ((v - min) / (max - min || 1)) * (h - 8)])
  const color = good ? 'var(--brand)' : 'var(--danger)'
  const last = pts[pts.length - 1]
  return (
    <svg width={w} height={h} aria-hidden="true">
      <polyline points={pts.map(p => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />
    </svg>
  )
}

/* ---------- StatTile ---------- */
export function StatTile({ label, value, unit, delta, hint, spark, icon, onClick, goodUp = true }: {
  label: string; value: ReactNode; unit?: string; delta?: { text: string; trend: 'up' | 'down' | 'flat'; good?: boolean }
  hint?: string; spark?: number[]; icon?: IconName; onClick?: () => void; goodUp?: boolean
}) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag className={`card stat ${onClick ? 'click' : ''}`} onClick={onClick} style={{ font: 'inherit', color: 'inherit' }}>
      <span className="lbl">{label}</span>
      <span className="val"><span className="kpi">{value}</span>{unit && <span className="unit">{unit}</span>}</span>
      {spark && <span className="spark"><Sparkline data={spark} good={goodUp} /></span>}
      {icon && !spark && <span className="ico"><Icon name={icon} /></span>}
      {(delta || hint) && (
        <span className="foot">
          {delta && (
            <span className={`delta ${delta.trend === 'flat' ? 'flat' : delta.good === false ? 'bad' : 'good'}`}>
              {delta.trend === 'up' ? '↗' : delta.trend === 'down' ? '↘' : ''} {delta.text}
            </span>
          )}
          {hint}
        </span>
      )}
    </Tag>
  )
}

/* ---------- ActionItem ---------- */
export function ActionItem({ icon, tone = 'brand', title, meta, badge, count, onClick }: {
  icon: IconName; tone?: 'danger' | 'warning' | 'brand' | 'info' | 'success' | 'neutral'; title: string; meta?: string; badge?: ReactNode; count?: number; onClick?: () => void
}) {
  return (
    <button className="action-item" onClick={onClick}>
      <span className={`ai-chip ${tone}`}><Icon name={icon} /></span>
      <span className="ai-main"><b>{title}</b>{meta && <span>{meta}</span>}</span>
      {badge}
      {count !== undefined && <span className="ai-count">{count}</span>}
      <Icon name="chevronRight" />
    </button>
  )
}
export function NeedsAction({ items, onViewAll }: { items: (Parameters<typeof ActionItem>[0] & { key?: string })[]; onViewAll?: () => void }) {
  const live = items.filter(i => (i.count ?? 1) > 0)
  return (
    <GlassCard title="Needs action" subtitle="Highest risk first" flush
      footer={<><span>Updated just now</span>{onViewAll && <Button variant="ghost" size="sm" onClick={onViewAll}>View all</Button>}</>}>
      {live.length === 0 ? <div className="tbl-empty"><Icon name="checkCircle" size={20} /><div>You&apos;re all caught up</div></div> : live.map((i, n) => <ActionItem key={i.key ?? n} {...i} />)}
    </GlassCard>
  )
}

/* ---------- Form ---------- */
export function Field({ label, hint, error, optional, children }: { label: string; hint?: string; error?: string; optional?: boolean; children: ReactNode }) {
  const auto = useId()
  // The label is tied to its control (accessible name, click-to-focus, test selectors); the message is announced with it.
  const child = isValidElement(children) ? (children as ReactElement<{ id?: string; 'aria-describedby'?: string }>) : undefined
  const id = child?.props.id ?? auto
  const msgId = `${id}-msg`
  return (
    <div className="field">
      <label htmlFor={id}>{label}{optional && <span className="subtle" style={{ fontWeight: 400 }}> (optional)</span>}</label>
      {child ? cloneElement(child, { id, 'aria-describedby': error || hint ? msgId : undefined }) : children}
      {error ? <div className="err" id={msgId}><Icon name="alert" size={12} />{error}</div> : hint ? <div className="hint" id={msgId}>{hint}</div> : null}
    </div>
  )
}
export const Input = (p: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) => {
  const { invalid, ...rest } = p
  return <input className="input" aria-invalid={invalid} {...rest} />
}
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement>) => <select className="select" {...p} />
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className="textarea" {...p} />
export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return <label className="check"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />{children}</label>
}

/* ---------- Tabs ---------- */
export function Tabs<T extends string>({ options, value, onChange }: { options: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map(o => (
        <button key={o.id} role="tab" aria-selected={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}{o.count !== undefined && <span className="n">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

/* ---------- Avatar / Person ---------- */
export const initials = (n: string) => n.split(' ').filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase()
export function Avatar({ name, brand, lg }: { name: string; brand?: boolean; lg?: boolean }) {
  return <span className={`avatar ${brand ? 'brand' : ''} ${lg ? 'lg' : ''}`} aria-hidden="true">{initials(name)}</span>
}
export function Person({ name, sub, brand }: { name: string; sub?: string; brand?: boolean }) {
  return <span className="person"><Avatar name={name} brand={brand} /><span><b>{name}</b>{sub && <span>{sub}</span>}</span></span>
}

/* ---------- PageHeader ---------- */
export function PageHeader({ eyebrow, title, display, summary, actions, crumbs }: {
  eyebrow?: string; title: string; display?: boolean; summary?: ReactNode; actions?: ReactNode; crumbs?: string[]
}) {
  return (
    <div className="page-head">
      <div>
        {crumbs && <div className="tree-bc">{crumbs.map((c, i) => <span key={i} className="row" style={{ gap: 6 }}>{i > 0 && <Icon name="chevronRight" size={12} />}{c}</span>)}</div>}
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        {display ? <div className="display">{title}</div> : <h1>{title}</h1>}
        {summary && <div className="muted" style={{ marginTop: 2 }}>{summary}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}

/* ---------- DataTable ---------- */
export type Col<T> = { key: string; header: string; render: (r: T) => ReactNode; align?: 'r'; width?: number | string }
export function DataTable<T>({ cols, rows, rowKey, selectable, selected, onSelect, toolbar, footer, onRowClick, empty = 'Nothing to show' }: {
  cols: Col<T>[]; rows: T[]; rowKey: (r: T) => string; selectable?: boolean; selected?: string[]; onSelect?: (ids: string[]) => void
  toolbar?: ReactNode; footer?: ReactNode; onRowClick?: (r: T) => void; empty?: string
}) {
  const sel = selected ?? []
  const all = rows.length > 0 && rows.every(r => sel.includes(rowKey(r)))
  return (
    <GlassCard strong flush footer={footer ?? <span>Showing {rows.length} {rows.length === 1 ? 'record' : 'records'}</span>}>
      {toolbar && <div className="tbl-tool" style={{ paddingTop: 16 }}>{toolbar}</div>}
      <div className="tbl-wrap">
        <table className="tbl stack-m">
          <thead>
            <tr>
              {selectable && <th style={{ width: 36 }}><input type="checkbox" aria-label="Select all" checked={all} onChange={e => onSelect?.(e.target.checked ? rows.map(rowKey) : [])} /></th>}
              {cols.map(c => <th key={c.key} className={c.align} style={{ width: c.width }}>{c.header}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const id = rowKey(r)
              return (
                <tr key={id} className={`${sel.includes(id) ? 'sel' : ''} ${onRowClick ? 'clickable' : ''}`} onClick={() => onRowClick?.(r)}>
                  {selectable && <td onClick={e => e.stopPropagation()}><input type="checkbox" aria-label="Select row" checked={sel.includes(id)} onChange={e => onSelect?.(e.target.checked ? [...sel, id] : sel.filter(x => x !== id))} /></td>}
                  {cols.map(c => <td key={c.key} data-h={c.header} className={c.align}>{c.render(r)}</td>)}
                </tr>
              )
            })}
            {rows.length === 0 && <tr><td colSpan={cols.length + (selectable ? 1 : 0)}><div className="tbl-empty">{empty}</div></td></tr>}
          </tbody>
        </table>
      </div>
    </GlassCard>
  )
}

/* ---------- OccupancyBar ---------- */
export const BED_COLORS = { occupied: 'var(--brand-fill)', reserved: 'var(--champagne)', available: 'var(--info)', blocked: 'var(--ink-subtle)' }
export function OccupancyBar({ occupied, reserved, available, blocked, scope }: { occupied: number; reserved: number; available: number; blocked: number; scope: string }) {
  const total = occupied + reserved + available + blocked || 1
  const pct = ((occupied / total) * 100).toFixed(1)
  const segs: [string, number, string][] = [['Occupied', occupied, BED_COLORS.occupied], ['Reserved', reserved, BED_COLORS.reserved], ['Available', available, BED_COLORS.available], ['Blocked', blocked, BED_COLORS.blocked]]
  return (
    <div>
      <div className="row" style={{ alignItems: 'baseline' }}><span className="kpi" style={{ fontSize: 28 }}>{pct}%</span><span className="muted">occupied</span></div>
      <div className="muted body-sm" style={{ marginBottom: 10 }}>{scope} · {total} beds</div>
      <div className="obar" role="img" aria-label={`Occupancy ${pct}%`}>
        {segs.filter(s => s[1] > 0).map(([k, n, c]) => <i key={k} style={{ flex: n, background: c }} />)}
      </div>
      <div className="legend">
        {segs.map(([k, n, c]) => <div key={k}><span className="sw" style={{ background: c }} />{k}<b>{n}</b></div>)}
      </div>
    </div>
  )
}

/* ---------- Alert / Blocked ---------- */
export function Alert({ tone = 'info', title, detail, action }: { tone?: 'info' | 'warning' | 'success' | 'danger'; title: string; detail?: ReactNode; action?: ReactNode }) {
  const ic: IconName = tone === 'success' ? 'checkCircle' : tone === 'info' ? 'info' : 'alert'
  return (
    <div className={`alert ${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="ic"><Icon name={ic} size={16} /></span>
      <div className="grow"><b>{title}</b>{detail && <span>{detail}</span>}</div>
      {action}
    </div>
  )
}
/** D-93: every blocked state explains reason + owner + next action. */
export function Blocked({ why, owner, next }: { why: string; owner?: string; next?: string }) {
  return (
    <div className="blocked" role="note">
      <span className="why">{why}</span>
      <span className="meta">{owner && <>Owner: {owner}</>}{owner && next && ' · '}{next && <>Next: {next}</>}</span>
    </div>
  )
}

/* ---------- Drawer / Modal ---------- */
export function Drawer({ open, onClose, title, subtitle, children, footer }: { open: boolean; onClose: () => void; title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEscape(open, onClose)
  if (!open) return null
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dr-head"><div><h1>{title}</h1>{subtitle && <div className="muted">{subtitle}</div>}</div><Button variant="ghost" icon="x" onClick={onClose} aria-label="Close" /></div>
        <div className="dr-body">{children}</div>
        {footer && <div className="dr-foot">{footer}</div>}
      </aside>
    </div>
  )
}
export function Modal({ open, onClose, title, subtitle, children, footer, wide }: { open: boolean; onClose: () => void; title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(open, onClose)
  if (!open) return null
  return (
    <div className="scrim center" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dr-head"><div><h1>{title}</h1>{subtitle && <div className="muted">{subtitle}</div>}</div><Button variant="ghost" icon="x" onClick={onClose} aria-label="Close" /></div>
        <div className="dr-body">{children}</div>
        {footer && <div className="dr-foot">{footer}</div>}
      </div>
    </div>
  )
}
function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
}

/* ---------- Toasts ---------- */
type Toast = { id: number; text: string; err?: boolean }
const ToastCtx = createContext<(t: string, err?: boolean) => void>(() => {})
export const useToast = () => useContext(ToastCtx)
export function ToastHost({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([])
  const seq = useRef(0)
  const push = useCallback((text: string, err?: boolean) => {
    const id = ++seq.current
    setList(l => [...l, { id, text, err }])
    setTimeout(() => setList(l => l.filter(t => t.id !== id)), err ? 7000 : 4000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {list.map(t => <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}><Icon name={t.err ? 'alert' : 'checkCircle'} />{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  )
}

/* ---------- Stepper ---------- */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="stepper">
      {steps.map((s, i) => (
        <span key={s} className="row" style={{ gap: 6 }}>
          {i > 0 && <span className="step-sep" />}
          <span className={`step ${i === current ? 'on' : i < current ? 'done' : ''}`}><i>{i < current ? '✓' : i + 1}</i>{s}</span>
        </span>
      ))}
    </div>
  )
}

/* ---------- Live countdown ---------- */
export function Countdown({ to, from, label, warnBelowMs = 12 * 3600_000 }: { to: number; from?: number; label?: string; warnBelowMs?: number }) {
  const now = useNow()
  const left = to - now
  const cls = left < 0 ? 'over' : left < warnBelowMs ? 'soon' : 'ok'
  const pct = from ? Math.max(0, Math.min(100, ((now - from) / (to - from)) * 100)) : undefined
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, minWidth: 120 }}>
      <span className={`cd ${cls}`}>{left < 0 ? `Overdue ${fmtDur(-left)}` : `${fmtDur(left)} left`}{label && <span className="subtle" style={{ fontWeight: 400 }}> · {label}</span>}</span>
      {pct !== undefined && <span className={`meter ${cls === 'ok' ? '' : cls}`}><i style={{ width: `${pct}%` }} /></span>}
    </span>
  )
}
