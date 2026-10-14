/**
 * CSV reading and writing for staff import and export. Pure functions, no I/O.
 *
 * Reading follows RFC 4180: a leading byte-order mark is dropped; CRLF, LF and lone CR end a record; a cell in double quotes
 * may hold commas, line breaks and "" for a quote. Anything that would make the rest of the file unreliable (an unterminated
 * quote, text glued to a closing quote) is a syntax error for the whole file instead of a guess.
 *
 * Writing goes through guardCsvCell() for EVERY cell, headers included (NFR-06): there is no other way to emit a CSV from here.
 */

export class CsvSyntaxError extends Error {
  constructor(message: string, public readonly row: number) { super(message) }
}

/** Splits CSV text into records of cells. A record number is the spreadsheet row (the first record is row 1). */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let i = 0
  const n = text.length
  const endCell = () => { row.push(cell); cell = '' }
  const endRow = () => { endCell(); rows.push(row); row = [] }

  while (i < n) {
    const ch = text[i]
    if (ch === '"' && cell === '') {
      // quoted cell
      i++
      for (;;) {
        if (i >= n) throw new CsvSyntaxError(`A quoted value that starts on row ${rows.length + 1} never closes`, rows.length + 1)
        const q = text[i]
        if (q === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue }
          i++
          break
        }
        cell += q
        i++
      }
      const next = text[i]
      if (i < n && next !== ',' && next !== '\n' && next !== '\r') {
        throw new CsvSyntaxError(`Unexpected text after a closing quote on row ${rows.length + 1}`, rows.length + 1)
      }
      continue
    }
    if (ch === ',') { endCell(); i++; continue }
    if (ch === '\r') { endRow(); i += text[i + 1] === '\n' ? 2 : 1; continue }
    if (ch === '\n') { endRow(); i++; continue }
    cell += ch
    i++
  }
  // last record without a trailing line break
  if (cell !== '' || row.length > 0) endRow()
  return rows
}

/** Characters that make a spreadsheet read a cell as a formula (OWASP CSV injection list, plus line feed). */
const FORMULA_START = /^[=+\-@\t\r\n]/

/** The single guard for every CSV we emit: a cell that could run as a formula is prefixed with an apostrophe. */
export function guardCsvCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value
}

/** Does the text start like a formula? Used by input validation too, so the same list applies on the way in. */
export const startsLikeFormula = (value: string): boolean => FORMULA_START.test(value)

function quoteIfNeeded(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Serialises rows to CSV text (CRLF, UTF-8 byte-order mark so Excel opens it correctly). Every cell is guarded. */
export function serializeCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  const lines = rows.map(r => r.map(c => quoteIfNeeded(guardCsvCell(c === null || c === undefined ? '' : String(c)))).join(','))
  return '﻿' + lines.join('\r\n') + (lines.length ? '\r\n' : '')
}
