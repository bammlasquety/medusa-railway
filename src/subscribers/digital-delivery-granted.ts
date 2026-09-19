import type { SubscriberArgs, SubscriberConfig } from '@medusajs/medusa'
import { Modules } from '@medusajs/framework/utils'

import { DIGITAL_DELIVERY_MODULE } from '../modules/digital-delivery'
import {
  DIGITAL_DELIVERY_GRANTED,
  type DigitalDeliveryGrantedPayload,
} from '../modules/digital-delivery/ports'
import { logCommerceIssue } from '../lib/commerce-issues'

/**
 * Delivers the links by email.
 *
 * Listens for `digital_delivery.granted` rather than `order.placed`, so an order
 * with no digital lines can never produce an email with an empty list in it.
 *
 * The tokens minted here get a 7-day life, not the 15 minutes an on-screen link
 * gets. A download link that dies before the customer reads their inbox is a
 * support ticket, not a security win — and it is still bounded by the grant's
 * own expiry and download cap, which are the limits that actually matter.
 */
export default async function digitalDeliveryGrantedHandler({
  event: { data },
  container,
}: SubscriberArgs<DigitalDeliveryGrantedPayload>) {
  const logger = container.resolve('logger')
  const delivery = container.resolve(DIGITAL_DELIVERY_MODULE) as any
  const notifications = container.resolve(Modules.NOTIFICATION)
  const query = container.resolve('query')

  const grants = await delivery.listDigitalGrants({ id: data.grant_ids })
  if (!grants.length) return

  const links = await delivery.issueLinks(grants, { purpose: 'email' })
  if (!links.length) {
    logger.warn(`[digital] order ${data.order_id} granted but produced no usable links`)
    await logCommerceIssue(logger, {
      stage: 'download',
      code: 'download.no_usable_links',
      severity: 'error',
      message: 'Download grants exist but no usable link could be issued (storage path / signing?).',
      orderId: data.order_id,
    })
    return
  }

  const { data: [order] } = await query.graph({
    entity: 'order',
    fields: ['id', 'display_id', 'email', 'currency_code', 'metadata'],
    filters: { id: data.order_id },
  })

  /**
   * The address the buyer confirmed for download links at checkout
   * (`metadata.digital_delivery_email`, copied from the cart), then the order's
   * own email. A signed-in buyer may choose an inbox other than their account's.
   */
  const chosen = String((order as any)?.metadata?.digital_delivery_email ?? '').trim()
  const to = (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(chosen) ? chosen : '') || order?.email || grants[0].email
  if (!to) {
    logger.error(`[digital] order ${data.order_id} has no email address to deliver to`)
    await logCommerceIssue(logger, {
      stage: 'fulfilment',
      code: 'fulfilment.no_email',
      severity: 'error',
      message: 'Order has download links but no email address to send them to.',
      orderId: data.order_id,
    })
    return
  }

  try {
    await notifications.createNotifications({
      to,
      channel: 'email',
      template: 'digital-downloads-ready',
      // Medusa stores this alongside the notification, which makes the email
      // reconstructable during a support conversation without guessing.
      data: {
        order_id: order?.id ?? data.order_id,
        order_display_id: order?.display_id ?? null,
        items: links.map((link: any) => ({
          title: link.title,
          file_name: link.fileName,
          url: link.url,
          downloads_remaining: link.downloadsRemaining,
          access_expires_at: link.accessExpiresAt,
        })),
        expires_at: links[0].expiresAt,
        access_expires_at: links[0].accessExpiresAt,
      },
    })
  } catch (error) {
    await logCommerceIssue(logger, {
      stage: 'fulfilment',
      code: 'fulfilment.email_failed',
      severity: 'error',
      message: `Download email could not be sent: ${(error as Error)?.message ?? error}`,
      orderId: data.order_id,
      email: to,
    })
    throw error
  }

  logger.info(`[digital] emailed ${links.length} download link(s) for order ${data.order_id}`)
}

export const config: SubscriberConfig = {
  event: DIGITAL_DELIVERY_GRANTED,
  context: { subscriberId: 'digital-delivery-email' },
}
