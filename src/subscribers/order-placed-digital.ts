import type { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'

import { fulfilDigitalItemsWorkflow } from '../workflows/fulfil-digital-items'
import { logCommerceIssue } from '../lib/commerce-issues'

/**
 * The trigger.
 *
 * `order.placed` rather than a PayMongo webhook, deliberately: an order is
 * placed the same way whether it was paid by card, GCash, an admin creating it
 * by hand, or a comp. Hanging delivery off one payment provider's webhook is
 * what the previous design did, and it would have silently stopped delivering
 * the day a second payment method was added.
 *
 * The workflow decides whether there is anything digital in the order; this
 * subscriber does not filter, because filtering here would duplicate the
 * catalogue rules in a second place.
 */
export default async function orderPlacedDigitalHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve('logger')

  try {
    await fulfilDigitalItemsWorkflow(container).run({
      input: { orderId: data.id },
    })
  } catch (error) {
    /**
     * Swallowed on purpose. A throw here fails the whole `order.placed` fan-out,
     * taking unrelated subscribers (receipts, analytics) down with it for an
     * order that is already paid and valid.
     *
     * The order sits unfulfilled in admin, which is a visible, recoverable state
     * — re-run the fulfillment from there. That is strictly better than a
     * retry storm on an event that has no idempotency key of its own.
     */
    logger.error(
      `[digital] fulfilment failed for order ${data.id}: ${(error as Error)?.message ?? error}`
    )
    await logCommerceIssue(logger, {
      stage: 'fulfilment',
      code: 'fulfilment.digital_failed',
      severity: 'critical',
      message: `Digital fulfilment failed: ${(error as Error)?.message ?? error}`,
      orderId: data.id,
    })
  }
}

export const config: SubscriberConfig = {
  event: 'order.placed',
  context: { subscriberId: 'digital-fulfilment-on-order-placed' },
}
