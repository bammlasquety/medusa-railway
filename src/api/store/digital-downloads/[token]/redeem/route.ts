import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'

import { DIGITAL_DELIVERY_MODULE } from '../../../../../modules/digital-delivery'

/**
 * POST /store/digital-downloads/:token/redeem
 *
 * Spends one download and returns a 60-second pre-signed storage URL.
 *
 * The token IS the authorisation — it is a 32-byte secret bound to one grant —
 * so there is no session check here. That is deliberate and it is what lets a
 * link in an email work for a guest who has no account.
 *
 * POST rather than GET for two reasons: this mutates a counter, and it keeps the
 * token out of Medusa's request logs, which record query strings but not bodies
 * on POST. (The token is still in the path; the storefront is the only caller
 * and it does not log paths with secrets.)
 *
 * Called server-to-server by the storefront's /api/downloads/[token], never by a
 * browser: the response contains a URL that must not be cached or shared.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const token = String(req.params.token ?? '')
  if (!token) {
    return res.status(400).json({ message: 'Missing token.' })
  }

  res.setHeader('Cache-Control', 'no-store, private')

  const delivery = req.scope.resolve(DIGITAL_DELIVERY_MODULE) as any
  const result = await delivery.redeem(token, req.ip ?? null)

  if (!result.ok) {
    /**
     * 410 rather than 404 for the expired cases: the link WAS valid once, and
     * that distinction is what tells the buyer to reopen their order page for a
     * fresh link instead of concluding the link was never real.
     */
    const statuses: Record<string, number> = {
      not_found: 404,
      token_expired: 410,
      access_expired: 410,
      limit_reached: 429,
      revoked: 403,
    }

    return res.status(statuses[result.reason] ?? 404).json({ reason: result.reason })
  }

  return res.json({
    url: result.url,
    file_name: result.fileName,
    downloads_remaining: result.downloadsRemaining,
  })
}
