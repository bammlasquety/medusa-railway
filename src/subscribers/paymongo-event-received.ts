import type { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'

import { PAYMONGO_EVENT_RECEIVED } from '../modules/paymongo-ledger'
import { settlePaymongoPaymentWorkflow } from '../workflows/settle-paymongo-payment'

/**
 * The queue worker.
 *
 * With `@medusajs/event-bus-redis` registered this runs in the WORKER process,
 * off the request path entirely, with BullMQ's retry and backoff behind it. The
 * webhook route has already answered PayMongo by the time this starts.
 *
 * It is deliberately thin. All judgement lives in the workflow, which can record
 * what it decided on the ledger row; a subscriber can only log.
 */
export default async function paymongoEventReceivedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ ledger_id: string }>) {
  const logger = container.resolve('logger')

  const ledgerId = String(data?.ledger_id ?? '')

  if (!ledgerId) {
    logger.error('[paymongo] queue message carried no ledger id; nothing to settle')
    return
  }

  try {
    await settlePaymongoPaymentWorkflow(container).run({ input: { ledgerId } })
  } catch (error) {
    /**
     * Rethrown, unlike `order-placed-digital`.
     *
     * That subscriber swallows because `order.placed` fans out to unrelated
     * handlers and one failure must not take receipts and analytics down with
     * it. Nothing else rides on this event, so throwing is free — and it is what
     * buys BullMQ's retry. The ledger row is already marked, so the failure is
     * recorded either way; this just asks for another attempt sooner than the
     * reconcile job would.
     */
    logger.error(
      `[paymongo] settling ${ledgerId} threw: ${(error as Error)?.message ?? error}`
    )
    throw error
  }
}

export const config: SubscriberConfig = {
  event: PAYMONGO_EVENT_RECEIVED,
  context: { subscriberId: 'paymongo-settle-on-webhook' },
}
