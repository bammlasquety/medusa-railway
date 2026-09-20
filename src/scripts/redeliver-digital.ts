import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'

import { fulfilDigitalItemsWorkflow } from '../workflows/fulfil-digital-items'

/**
 * Re-runs digital delivery for orders whose delivery was refused or failed —
 * e.g. the orders blocked on 2026-09-20 by the payment_status bug.
 *
 *   ORDER_IDS=order_01…,order_02… npx medusa exec ./src/scripts/redeliver-digital.ts
 *
 * Safe to repeat: grants are unique per order line, and the payment gate still
 * applies — an unpaid order is refused again, not delivered. On success the
 * old "blocked" markers are removed from the order's metadata.
 */
export default async function redeliverDigital({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const orderModule = container.resolve(Modules.ORDER) as any

  const ids = String(process.env.ORDER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.startsWith('order_'))

  if (!ids.length) {
    logger.error('[redeliver] set ORDER_IDS=order_…,order_… (comma separated)')
    return
  }

  for (const orderId of ids) {
    try {
      const { result } = await fulfilDigitalItemsWorkflow(container).run({ input: { orderId } })
      const grants = (result as any)?.grantIds?.length ?? 0

      if (grants) {
        const order = await orderModule.retrieveOrder(orderId, { select: ['id', 'metadata'] })
        const metadata = { ...(order?.metadata ?? {}) }
        for (const key of [
          'digital_delivery_status',
          'digital_delivery_blocked_reason',
          'digital_delivery_payment_status',
          'digital_delivery_blocked_at',
        ]) {
          delete metadata[key]
        }
        await orderModule.updateOrders([{ id: orderId, metadata }])
      }

      logger.info(`[redeliver] ${orderId}: ${grants} grant(s) issued`)
    } catch (error) {
      logger.error(`[redeliver] ${orderId} failed: ${(error as Error)?.message ?? error}`)
    }
  }
}
