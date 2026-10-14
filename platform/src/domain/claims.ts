import { addDays } from './time'

/**
 * Converts an inclusive business window ('YYYY-MM-DD' start, optional inclusive end) into the Postgres
 * daterange literal stored in bed_claim.period: '[start, end+1)'. Open-ended stays have no upper bound.
 * Using the half-open form is what makes back-to-back stays (one ends 14 Oct, the next starts 15 Oct) legal
 * while a shared day is a conflict, exactly like rules.overlaps().
 */
export function claimPeriod(from: string, to?: string): string {
  return to ? `[${from},${addDays(to, 1)})` : `[${from},)`
}
