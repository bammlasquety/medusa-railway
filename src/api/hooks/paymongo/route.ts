import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'

import { verifyPaymongoSignature } from '../../../modules/paymongo/client'
import { PAID_EVENT_TYPE, parsePaymongoEvent } from '../../../modules/paymongo/event-payload'
import {
  PAYMONGO_EVENT_RECEIVED,
  PAYMONGO_LEDGER_MODULE,
} from '../../../modules/paymongo-ledger'
import type PaymongoLedgerService from '../../../modules/paymongo-ledger/service'
import { logCommerceIssue } from '../../../lib/commerce-issues'

/**
 * PayMongo's webhook endpoint.
 *
 * The handler does four things and deliberately nothing else:
 *
 *   1. verify the signature over the RAW body
 *   2. claim the event id in `paymongo_events`
 *   3. hand the work to the queue
 *   4. answer 200
 *
 * No order is created here, no payment is captured here, nothing calls PayMongo
 * here. That is not tidiness — it is the reason the endpoint is reliable.
 * PayMongo's delivery timeout is short and its retry policy is twelve attempts;
 * an endpoint that does the work inline turns one slow `cart.complete()` into a
 * timeout, which PayMongo reads as a failed delivery, which produces a retry
 * that races the request still running. Acknowledge fast, work later.
 *
 * The response body is intentionally uninformative. This route is public and
 * unauthenticated by necessity, so it tells an unsigned caller nothing about
 * whether an id exists, what shape the payload should be, or how far it got.
 */

/**
 * A webhook secret belongs to the ENDPOINT, not the account. While the built-in
 * `/hooks/payment/paymongo_paymongo` route and this one are both registered in
 * the PayMongo dashboard there are two secrets in play, and during a rotation
 * there are briefly two for this endpoint alone.
 *
 * A comma-separated list, tried in order, is what makes both of those survivable
 * without a deploy window in which live payments are rejected.
 */
function webhookSecrets(): string[] {
  const raw =
    process.env.PAYMONGO_WEBHOOK_SECRETS ?? process.env.PAYMONGO_WEBHOOK_SECRET ?? ''

  return raw
    .split(',')
    .map((secret) => secret.trim())
    .filter(Boolean)
}

function signatureHeader(req: MedusaRequest): string {
  const headers = req.headers as any
  const value = headers?.['paymongo-signature'] ?? headers?.['Paymongo-Signature'] ?? ''
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}

export const POST = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  const logger = req.scope.resolve('logger') as any

  /**
   * The RAW body, not `req.body`.
   *
   * The signature covers the exact bytes PayMongo sent. `JSON.parse` followed by
   * `JSON.stringify` reorders keys and normalises numbers, so verifying against
   * a re-serialised body fails for a genuine event and — worse — a handler that
   * verifies one representation and then acts on a different one is a signature
   * bypass wearing a helmet. Everything below is derived from `raw`.
   *
   * Requires `bodyParser: { preserveRawBody: true }` on this matcher in
   * middlewares.ts. Without it `rawBody` is undefined and every delivery is
   * rejected — which is the safe direction to fail, but check there first if
   * nothing is arriving.
   */
  const rawBody = (req as any).rawBody
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '')

  if (!raw) {
    logger.error('[paymongo] webhook received with no raw body; is preserveRawBody configured?')
    res.status(400).json({ received: false })
    return
  }

  const secrets = webhookSecrets()

  if (!secrets.length) {
    // Refusing beats accepting. An unset secret with a permissive handler is an
    // open endpoint that creates orders.
    logger.error('[paymongo] no webhook secret configured; rejecting delivery')
    await logCommerceIssue(logger, {
      stage: 'webhook',
      code: 'webhook.secret_missing',
      severity: 'critical',
      message: 'PAYMONGO_WEBHOOK_SECRET is not set; every PayMongo webhook is being rejected.',
      fingerprint: 'webhook|webhook.secret_missing',
    })
    res.status(500).json({ received: false })
    return
  }

  const header = signatureHeader(req)

  const verified = secrets.some((secret) =>
    verifyPaymongoSignature({ rawBody: raw, signatureHeader: header, secret })
  )

  if (!verified) {
    /**
     * 401, not 200.
     *
     * Answering 200 to an unsigned caller would stop PayMongo retrying a
     * delivery whose secret we had merely misconfigured, and would silently
     * absorb an attacker probing the endpoint. Neither is a state worth being
     * quiet about.
     */
    logger.error('[paymongo] webhook signature rejected')
    await logCommerceIssue(logger, {
      stage: 'webhook',
      code: 'webhook.signature_rejected',
      severity: 'warning',
      message: 'A PayMongo webhook failed signature verification. Check PAYMONGO_WEBHOOK_SECRET matches this endpoint.',
      fingerprint: 'webhook|webhook.signature_rejected',
    })
    res.status(401).json({ received: false })
    return
  }

  let body: unknown

  try {
    body = JSON.parse(raw)
  } catch {
    logger.error('[paymongo] webhook body verified but is not JSON')
    res.status(400).json({ received: false })
    return
  }

  const event = parsePaymongoEvent(body)

  if (!event.eventId) {
    /**
     * Signed, but with no event id there is nothing to be idempotent ON. Taking
     * it anyway would mean processing every retry of it as if it were new.
     */
    logger.error(`[paymongo] signed webhook carried no event id (type=${event.eventType})`)
    res.status(400).json({ received: false })
    return
  }

  const ledger = req.scope.resolve(PAYMONGO_LEDGER_MODULE) as PaymongoLedgerService

  /**
   * Everything is claimed, including event types we do not act on. The row costs
   * nothing and it is the difference between "PayMongo has never called us" and
   * "PayMongo calls us constantly with events we ignore" — two situations that
   * look identical from the outside and need opposite fixes.
   */
  const actionable = event.eventType === PAID_EVENT_TYPE

  const claim = await ledger.claim({
    eventId: event.eventId,
    eventType: event.eventType,
    livemode: event.livemode,
    payload: body,
    reference: event.reference || null,
    cartId: event.cartId || null,
    paymentSessionId: event.paymentSessionId || null,
    paymongoPaymentId: event.paymongoPaymentId || null,
    ignored: !actionable,
  })

  if (!claim.claimed) {
    /**
     * A duplicate. This is the normal case, not an error: PayMongo redelivers up
     * to twelve times and will keep doing so until it gets a 200, so most of
     * these are our own earlier success being confirmed.
     *
     * `info`, and no work of any kind.
     */
    logger.info(`[paymongo] duplicate webhook ${event.eventId} (${claim.status}); acknowledged`)
    res.status(200).json({ received: true, duplicate: true })
    return
  }

  if (!actionable) {
    logger.info(`[paymongo] recorded ${event.eventType} ${event.eventId}; no action taken`)
    res.status(200).json({ received: true })
    return
  }

  /**
   * Hand off to the queue.
   *
   * A failure here is survivable and must not become a 500: the ledger row
   * already exists in state `claimed`, and `reconcile-paymongo-events` re-emits
   * anything that has sat in that state. Answering 200 to PayMongo while the job
   * is merely late is correct; answering 500 would buy a retry we do not need
   * and cannot use, because the event id is already claimed.
   */
  try {
    await req.scope.resolve(Modules.EVENT_BUS).emit({
      name: PAYMONGO_EVENT_RECEIVED,
      data: { ledger_id: claim.id },
    })
  } catch (error) {
    logger.error(
      `[paymongo] could not enqueue ${event.eventId}: ${(error as Error)?.message ?? error}. ` +
        'The reconcile job will pick it up.'
    )
  }

  res.status(200).json({ received: true })
}

/**
 * PayMongo only ever POSTs. A GET is either a human checking the URL or a
 * scanner; both get the same content-free answer.
 */
export const GET = async (_req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  res.status(405).json({ received: false })
}
