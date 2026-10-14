import { randomInt } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'

/** OWASP Argon2id minimum: 19 MiB, 2 iterations, 1 lane. Output is the PHC string "$argon2id$v=19$…". */
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const

export const hashPassword = (plain: string): Promise<string> => hash(plain, OPTS)

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain)
  } catch {
    return false // malformed hash: treat as a failed sign-in, never as an error that reveals state
  }
}

let dummy: Promise<string> | undefined
/** Verifying against this when the user does not exist keeps response time close to a real check. */
export function burnVerify(plain: string): Promise<boolean> {
  dummy ??= hashPassword('not-a-real-password-' + Math.random())
  return dummy.then(h => verifyPassword(h, plain))
}

const COMMON = new Set([
  'password', 'password1', 'password123', '1234567890', '12345678', '123456789', 'qwertyuiop', 'qwerty123',
  'letmein123', 'welcome123', 'admin12345', 'iloveyou12', 'changeme123', 'grandhyatt', 'hyatt12345',
])

/** Returns what to fix, or undefined when the password is acceptable. Length comes from configuration (GH-14, open). */
export function passwordProblem(plain: string, ctx: { username: string; minLength: number }): string | undefined {
  if (plain.length < ctx.minLength) return `Use at least ${ctx.minLength} characters`
  if (plain.length > 200) return 'Use at most 200 characters'
  const lower = plain.toLowerCase()
  if (lower === ctx.username.trim().toLowerCase()) return 'The password cannot be the same as the username'
  if (COMMON.has(lower)) return 'That password is too common'
  if (/^(.)\1+$/.test(plain)) return 'Use more than one repeated character'
  return undefined
}

/** No look-alike characters (0/O, 1/l/I): this is read aloud or typed from a printout. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
export function temporaryPassword(length = 12): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}
