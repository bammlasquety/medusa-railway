import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http'

/**
 * Refuses any request that carries what looks like a raw card number.
 *
 * Nothing in this system is supposed to be able to send one. PayMongo Hosted
 * Checkout collects the card on PayMongo's own page; the storefront never
 * renders a PAN field and the backend has no route that would know what to do
 * with one. This middleware exists precisely BECAUSE that is true — it is the
 * tripwire that tells you the day it stops being true.
 *
 * The threat it addresses is not an attacker; it is a well-meaning change. A
 * "let's collect the card ourselves and just forward it" spike, a debug endpoint
 * that echoes a request body into a log, a third-party form posting to the wrong
 * origin. Any of those quietly drags this deployment into PCI DSS scope, and the
 * first evidence is usually a card number sitting in a log aggregator that six
 * services can read.
 *
 * It is a guard, not a control: it cannot stop card data reaching a system that
 * chooses to accept it. It can make sure that choice is deliberate, visible in a
 * diff, and loud in the logs the first time it happens.
 */

/** `number` is included and is the reason the Luhn check below exists — on its
 *  own it matches quantity fields, page numbers and phone numbers. */
const PAN_KEYS = /^(card[_-]?number|cardnumber|pan|account[_-]?number|number)$/i
const CODE_KEYS = /^(cvv|cvc|cvv2|cvc2|security[_-]?code|card[_-]?code)$/i

const MAX_DEPTH = 6

/**
 * Luhn. A 16-digit order reference or a phone number will not pass it, a real
 * card number always will — which is what keeps this from rejecting legitimate
 * traffic while still catching the thing it is looking for.
 */
function looksLikeCardNumber(value: unknown): boolean {
  const digits = String(value ?? '').replace(/[\s-]/g, '')

  if (!/^\d{13,19}$/.test(digits)) return false

  let sum = 0
  let double = false

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }

  return sum % 10 === 0
}

/** Returns the offending KEY PATH, never the value. */
function findCardData(node: unknown, path: string[] = [], depth = 0): string | null {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return null

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = findCardData(node[i], [...path, String(i)], depth + 1)
      if (hit) return hit
    }
    return null
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const here = [...path, key].join('.')

    if (CODE_KEYS.test(key) && /^\d{3,4}$/.test(String(value ?? ''))) return here
    if (PAN_KEYS.test(key) && looksLikeCardNumber(value)) return here

    const hit = findCardData(value, [...path, key], depth + 1)
    if (hit) return hit
  }

  return null
}

export function rejectRawCardData(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
): void {
  const body = (req as any).body

  if (body && typeof body === 'object') {
    const offendingPath = findCardData(body)

    if (offendingPath) {
      const logger = req.scope.resolve('logger') as any

      /**
       * The PATH is logged; the value never is. Writing the number into the log
       * line would commit the exact sin the middleware is here to prevent.
       */
      logger.error(
        `[security] rejected a request to ${req.path} carrying card-like data at ` +
          `"${offendingPath}". This system must never receive raw card details — ` +
          'PayMongo Hosted Checkout collects them on their own page.'
      )

      res.status(400).json({
        message:
          'Card details must never be sent to this API. Payment is collected on PayMongo’s ' +
          'hosted checkout page.',
      })
      return
    }
  }

  next()
}

export default rejectRawCardData
