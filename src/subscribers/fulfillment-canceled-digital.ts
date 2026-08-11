import type { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'

import { DIGITAL_DELIVERY_MODULE } from '../modules/digital-delivery'

/**
 * Revocation on cancel.
 *
 * The fulfillment provider cannot do this itself — it has the Fulfillment
 * module's scoped container and cannot reach the delivery module (ADR 0001). So
 * the provider's `cancelFulfillment` records the cancel and this subscriber does
 * the part that has teeth.
 *
 * Revocation is checked at redemption, so it takes effect immediately — even for
 * a 7-day token already sitting in the buyer's inbox. That is the concrete
 * payoff of redeeming through Medusa rather than emailing a raw signed URL.
 */
export default async function fulfillmentCanceledDigitalHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve('logger')
  const query = container.resolve('query')

  const { data: [fulfillment] } = await query.graph({
    entity: 'fulfillment',
    fields: ['id', 'provider_id', 'order.id'],
    filters: { id: data.id },
  })

  // Only ours. Cancelling a seedling shipment must not revoke an ebook.
  if (!fulfillment?.provider_id?.startsWith('fp_digital')) return

  const orderId = fulfillment.order?.id
  if (!orderId) return

  const delivery = container.resolve(DIGITAL_DELIVERY_MODULE) as any
  const revoked = await delivery.revokeForOrder(orderId)

  logger.info(`[digital] revoked ${revoked} grant(s) for order ${orderId} after fulfillment cancel`)
}

export const config: SubscriberConfig = {
  event: 'fulfillment.canceled',
  context: { subscriberId: 'digital-delivery-revoke-on-cancel' },
}
