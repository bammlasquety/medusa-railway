import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http'

/**
 * A cheap ceiling on an endpoint that has to be public.
 *
 * The webhook route cannot require a credential — PayMongo would not have one to
 * send. Its defence is the signature, and a signature check costs an HMAC over
 * the body every time it fails. That is fine at PayMongo's volume and not fine
 * when someone points a load generator at it.
 *
 * Honest about what it is: an IN-PROCESS fixed window. With more than one Medusa
 * instance the effective limit is this number times the instance count, and a
 * redeploy resets it. It is a guard against noise and accidental loops, not a
 * substitute for a rate limit at the edge — put one on Railway or Cloudflare if
 * this endpoint ever gets attention.
 *
 * PayMongo's own traffic is nowhere near this: twelve retries per event, spread
 * over hours.
 */

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 120

/** Bounded so a spray of forged IPs cannot turn the guard into the leak. */
const MAX_TRACKED = 5_000

const counters = new Map<string, { count: number; resetAt: number }>()

function callerKey(req: MedusaRequest): string {
  const forwarded = String((req.headers as any)?.['x-forwarded-for'] ?? '')
  const first = forwarded.split(',')[0]?.trim()
  return first || (req as any).ip || 'unknown'
}

export function webhookFloodGuard(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
): void {
  const now = Date.now()
  const key = callerKey(req)

  if (counters.size > MAX_TRACKED) counters.clear()

  const current = counters.get(key)

  if (!current || current.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + WINDOW_MS })
    next()
    return
  }

  current.count += 1

  if (current.count > MAX_PER_WINDOW) {
    /**
     * 429 rather than a silent drop. PayMongo backs off on a 429 and retries,
     * so a legitimate burst that trips this is delayed rather than lost — and
     * the ledger means a delayed retry is indistinguishable from an on-time one.
     */
    res.status(429).json({ received: false })
    return
  }

  next()
}

export default webhookFloodGuard
