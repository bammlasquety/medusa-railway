import type { MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'

import { PAYMONGO_EVENT_RECEIVED, PAYMONGO_LEDGER_MODULE } from '../modules/paymongo-ledger'
import type PaymongoLedgerService from '../modules/paymongo-ledger/service'
import { logCommerceIssue } from '../lib/commerce-issues'

/**
 * The promise-keeper.
 *
 * Writing the ledger row before doing the work is what makes the webhook
 * idempotent — and it is also what creates the one failure mode idempotency
 * introduces: an event that was claimed, so PayMongo will never send it again,
 * and then never processed, because the worker was redeployed mid-flight or the
 * enqueue threw after the row was committed. Without this job that payment is
 * lost silently and permanently, and the customer's order simply never exists.
 *
 * So every few minutes: anything still sitting in `claimed` or `processing` past
 * the grace period goes back on the queue. Re-driving is safe because settling
 * is idempotent all the way down — a completed cart returns its existing order.
 */

/**
 * Long enough that an event merely queued behind others is not treated as lost;
 * short enough that a buyer who paid is not waiting on the next sweep.
 */
const GRACE_MINUTES = 5

/**
 * After this many attempts the event stops being a transient failure and starts
 * being a bug. Replaying it forever would hide that, and would keep a poisoned
 * payload cycling through the queue indefinitely.
 */
const MAX_ATTEMPTS = 6

const BATCH = 50

export default async function reconcilePaymongoEvents(container: MedusaContainer) {
  const logger = container.resolve('logger') as any
  const ledger = container.resolve(PAYMONGO_LEDGER_MODULE) as PaymongoLedgerService

  const cutoff = new Date(Date.now() - GRACE_MINUTES * 60 * 1000)

  const stuck = await ledger.listStuck(cutoff, MAX_ATTEMPTS, BATCH)

  if (!stuck.length) return

  logger.warn(`[paymongo] re-driving ${stuck.length} unsettled webhook event(s)`)

  const eventBus = container.resolve(Modules.EVENT_BUS) as any

  for (const row of stuck) {
    try {
      await eventBus.emit({
        name: PAYMONGO_EVENT_RECEIVED,
        data: { ledger_id: String((row as any).id) },
      })
    } catch (error) {
      // Left in place for the next sweep rather than marked failed: the queue
      // being unavailable says nothing about the event.
      logger.error(
        `[paymongo] could not re-enqueue ${(row as any).id}: ` +
          `${(error as Error)?.message ?? error}`
      )
    }
  }

  /**
   * Anything that has burned through MAX_ATTEMPTS is invisible to the query
   * above, on purpose — but it must not be invisible to you. This is the number
   * to alert on.
   */
  const abandoned = await ledger.listPaymongoEvents(
    { status: ['claimed', 'processing'], attempts: { $gte: MAX_ATTEMPTS } },
    { take: 1, select: ['id'] }
  )

  if (abandoned.length) {
    await logCommerceIssue(logger, {
      stage: 'webhook',
      code: 'webhook.retries_exhausted',
      severity: 'critical',
      message:
        'PayMongo webhook events are past the retry limit and are no longer re-driven. ' +
        `Check paymongo_events where status <> 'processed' and attempts >= ${MAX_ATTEMPTS}.`,
      fingerprint: 'webhook|webhook.retries_exhausted',
    })
    logger.error(
      '[paymongo] there are webhook events past the retry limit that no longer get re-driven. ' +
        "select * from paymongo_events where status <> 'processed' and attempts >= " +
        `${MAX_ATTEMPTS};`
    )
  }
}

export const config = {
  name: 'reconcile-paymongo-events',
  schedule: '*/5 * * * *',
}
