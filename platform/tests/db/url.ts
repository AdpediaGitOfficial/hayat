/** Same server and credentials as `url`, different database. */
export function withDatabase(url: string, dbName: string): string {
  const u = new URL(url)
  u.pathname = '/' + dbName
  return u.toString()
}
