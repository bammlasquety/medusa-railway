import { authenticate, defineMiddlewares } from '@medusajs/framework/http'

import { rejectRawCardData } from './_middlewares/reject-raw-card-data'
import { webhookFloodGuard } from './_middlewares/webhook-flood-guard'

/**
 * Route protection for the digital download endpoints, the PayMongo webhook, and
 * the store API's card-data tripwire.
 *
 * The download split is the whole authorisation story:
 *
 *   /store/digital-downloads              two accepted callers, checked in the
 *                                         handler: a signed-in customer, or the
 *                                         storefront server presenting the
 *                                         shared service key on behalf of a
 *                                         guest.
 *
 *   /store/digital-downloads/:token/redeem  requires nothing, because the token
 *                                         IS the credential. Requiring a session
 *                                         here would break every emailed link
 *                                         for guests.
 *
 * `allowUnauthenticated: true` looks alarming and is correct: it populates
 * `req.auth_context` when a session exists WITHOUT rejecting the guest path.
 * The actual decision is made in the route handler, where both credentials can
 * be weighed. A hard `authenticate()` here would lock guests out of their own
 * purchases.
 *
 * If you already have a middlewares.ts, merge these entries into its `routes`
 * array rather than replacing the file.
 */
export default defineMiddlewares({
  routes: [
    {
      matcher: '/store/digital-downloads',
      method: 'GET',
      middlewares: [
        authenticate('customer', ['bearer', 'session'], { allowUnauthenticated: true }),
      ],
    },

    /**
     * Nothing in this system may accept a raw card number. See
     * `_middlewares/reject-raw-card-data.ts` — this is the tripwire for the day
     * someone changes that by accident.
     *
     * On `/store/*` rather than globally: admin routes are authenticated and
     * `/hooks/*` bodies are provider-shaped, while `/store/*` is the surface
     * anyone holding a publishable key can post to.
     */
    {
      matcher: '/store/*',
      middlewares: [rejectRawCardData],
    },

    /**
     * The PayMongo webhook.
     *
     * `preserveRawBody` is LOAD-BEARING, not an optimisation: the signature
     * covers the exact bytes PayMongo sent, and a re-serialised body does not
     * hash to the same value. Remove this and every delivery is rejected as
     * unsigned — which fails safe, and will still cost you an afternoon.
     *
     * The size limit bounds what an unauthenticated caller can make the process
     * hold in memory before the signature check has had a chance to reject it.
     * A real PayMongo event is a few kilobytes.
     */
    {
      matcher: '/hooks/paymongo',
      method: 'POST',
      bodyParser: { preserveRawBody: true, sizeLimit: '256kb' },
      middlewares: [webhookFloodGuard],
    },
  ],
})
