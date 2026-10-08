/**
 * Credentials and bearer tokens.
 *
 * Passwords: scrypt via node:crypto. Tokens: 32 random bytes, base64url, stored
 * only as sha256 — a stolen database yields no usable session.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function hashPassword(password) {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(hashHex, 'hex')
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function newToken() {
  return randomBytes(32).toString('base64url')
}

export function newId() {
  return randomBytes(16).toString('hex')
}

export const SESSION_TTL_MS = 1000 * 60 * 60 * 2
export const REFRESH_TTL_MS = 1000 * 60 * 60 * 24 * 7
export const LOCKOUT_THRESHOLD = 5
export const LOCKOUT_MS = 1000 * 60 * 15
