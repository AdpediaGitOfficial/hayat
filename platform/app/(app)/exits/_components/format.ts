/** '2026-10-14 09:42 UTC': the screens show server time (site time zones are a G-01 question). Plain module, usable on the server. */
export const utc = (iso: string) => iso.slice(0, 16).replace('T', ' ') + ' UTC'
