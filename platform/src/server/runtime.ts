import { systemClock, type Clock } from '@/server/clock'

/** The process-wide clock. Production never changes it; tests and the UAT environment may (see STAGE-1 test strategy). */
let current: Clock = systemClock
export const getClock = (): Clock => current
export function setClock(c: Clock): void { current = c }
export function resetClock(): void { current = systemClock }
