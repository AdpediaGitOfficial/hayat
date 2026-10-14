/**
 * Injectable clock. Production code asks a Clock for the time and never calls Date.now() directly,
 * so reminder, SLA, offer-expiry and no-show boundaries can be tested to the millisecond.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number
  now(): Date
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  now: () => new Date(),
}

/** Deterministic clock for tests (and for demo/UAT environments that need to jump forward). */
export class FixedClock implements Clock {
  private ms: number

  constructor(start: number | Date | string = Date.UTC(2026, 9, 14, 9, 42, 0)) {
    this.ms = start instanceof Date ? start.getTime() : typeof start === 'string' ? Date.parse(start) : start
    if (Number.isNaN(this.ms)) throw new Error('FixedClock: invalid start time')
  }

  nowMs() { return this.ms }
  now() { return new Date(this.ms) }

  /** Move time forward (or back, with a negative value). Returns the clock for chaining. */
  advance(ms: number) { this.ms += ms; return this }
  set(to: number | Date | string) { this.ms = new FixedClock(to).ms; return this }
}
