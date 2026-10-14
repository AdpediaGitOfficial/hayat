'use client'
import { useEffect, useState } from 'react'

export function useNow(intervalMs = 1000): number {
  const [n, setN] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setN(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return n
}

const p2 = (n: number) => String(n).padStart(2, '0')
export function fmtDur(ms: number): string {
  const neg = ms < 0
  let s = Math.floor(Math.abs(ms) / 1000)
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const body = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${p2(m)}m` : `${m}m ${p2(s)}s`
  return (neg ? '-' : '') + body
}
