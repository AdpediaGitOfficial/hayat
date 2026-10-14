/**
 * Builds the Postgres daterange literal stored in bed_claim.period from a business window ('YYYY-MM-DD').
 * D-103: the end date is the DEPARTURE DAY, so the range is half-open '[arrival, departure)'. A resident can
 * leave on 14 Oct and the next one arrive the same day (same-day turnover), and two claims overlap only if they
 * share a night, exactly like rules.overlaps(). Open-ended stays have no upper bound.
 */
export function claimPeriod(from: string, to?: string): string {
  if (to !== undefined && to <= from) throw new Error(`Departure ${to} must be after arrival ${from}`)
  return to ? `[${from},${to})` : `[${from},)`
}
