import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'

import { DIGITAL_DELIVERY_MODULE } from '../../../modules/digital-delivery'

/**
 * GET /store/digital-downloads?order_id=…
 *
 * Mints fresh 15-minute links for an order. Safe to call on every page load —
 * that is the point: nothing long-lived is ever handed to a browser.
 *
 * Two callers are accepted, and the difference matters:
 *
 *   1. A SIGNED-IN CUSTOMER. Being authenticated is not enough — the order's
 *      `customer_id` must match theirs. Skipping that second check would let any
 *      customer read any order's downloads by guessing an id, which is the
 *      textbook IDOR.
 *
 *   2. THE STOREFRONT SERVER, presenting `x-digital-delivery-key`. This is the
 *      guest path: a guest proved ownership to the storefront with the httpOnly
 *      claim cookie set at checkout, and the storefront vouches for them here.
 *      The key is a server-to-server secret and must never reach a browser.
 *
 * Without (2), guests could not collect their own purchase from the success
 * page — which is most of the buyers on a store that does not force sign-up.
 */
/**
 * `AuthenticatedMedusaRequest`, not `MedusaRequest` — only the former carries
 * `auth_context`. The middleware runs with `allowUnauthenticated: true`, so the
 * context may be absent, which is why the handler checks rather than assumes.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const orderId = String(req.query.order_id ?? '')
  if (!orderId) {
    return res.status(400).json({ message: '`order_id` is required.' })
  }

  const query = req.scope.resolve('query')

  const { data: [order] } = await query.graph({
    entity: 'order',
    fields: ['id', 'customer_id'],
    filters: { id: orderId },
  })

  const customerId = req.auth_context?.actor_id
  const serviceKey = process.env.DIGITAL_DELIVERY_SERVICE_KEY
  const presented = req.headers['x-digital-delivery-key']

  // `Boolean(serviceKey) &&` is load-bearing: without it, an unset env var makes
  // every caller that omits the header a trusted one.
  const trustedServer = Boolean(serviceKey) && presented === serviceKey
  const ownsOrder = Boolean(customerId) && order?.customer_id === customerId

  // Unknown order and someone else's order get the same answer, so this cannot
  // be used to probe which order ids exist.
  if (!order || (!trustedServer && !ownsOrder)) {
    return res.status(404).json({ message: 'Order not found.' })
  }

  const delivery = req.scope.resolve(DIGITAL_DELIVERY_MODULE) as any
  const grants = await delivery.listDigitalGrants({ order_id: orderId })

  if (!grants.length) {
    return res.json({ state: 'none', items: [] })
  }

  const links = await delivery.issueLinks(grants, {
    purpose: 'page',
    ip: req.ip ?? null,
  })

  // Grants exist but none are usable: expired, revoked, or out of downloads.
  // Distinct from "none", because the buyer did purchase a file and deserves to
  // be told what happened to it rather than shown an empty page.
  if (!links.length) {
    return res.json({
      state: 'exhausted',
      items: [],
      titles: grants.map((grant: any) => grant.title),
    })
  }

  return res.json({ state: 'ready', items: links })
}
