import { fail, ok, type Result } from '@/server/command/result'
import { isUuid } from '@/server/commands/property/shared'

/** The id from a route path, or undefined when it cannot possibly exist (answered 404, never a database error). */
export const idParam = (params: Record<string, string>): string | undefined => (params.id && isUuid(params.id) ? params.id : undefined)

/** A query that returns undefined for "not found or not yours" becomes a 404, which never says which of the two it was. */
export const found = <T>(v: T | undefined): Result<T> => (v === undefined ? fail.notFound() : ok(v))
