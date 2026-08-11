import { authenticate, defineMiddlewares } from '@medusajs/framework/http'

/**
 * Route protection for the digital download endpoints.
 *
 * The split here is the whole authorisation story:
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
 * If you already have a middlewares.ts, merge this entry into its `routes`
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
  ],
})
