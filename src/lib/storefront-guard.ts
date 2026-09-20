import type { MedusaRequest } from '@medusajs/framework/http'
import { timingSafeEqual } from 'node:crypto'

/**
 * True only for requests from OUR storefront server.
 *
 * The password-reset routes sit behind the storefront on purpose: it owns the
 * shared rate limiter (per IP and per email), and a route anyone with the
 * publishable key could hit directly would bypass it. The storefront proves
 * itself with the same server-to-server secret it already uses for digital
 * delivery. Unset secret = nobody is trusted (fail closed).
 */
export function isTrustedStorefront(req: MedusaRequest): boolean {
  const expected = String(process.env.STOREFRONT_SERVICE_KEY || process.env.DIGITAL_DELIVERY_SERVICE_KEY || '')
  const presented = String(req.headers['x-storefront-key'] ?? '')
  if (!expected || !presented) return false

  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The shopper's IP as the storefront saw it — for the audit column only, never for decisions. */
export const storefrontClientIp = (req: MedusaRequest): string | null =>
  String(req.headers['x-storefront-client-ip'] ?? '').slice(0, 64) || null
