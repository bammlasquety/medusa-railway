/**
 * One reader for PayMongo's webhook envelope.
 *
 * Two things consume a PayMongo webhook now — Medusa's built-in
 * `/hooks/payment/paymongo_paymongo` route via `getWebhookActionAndData`, and
 * our own `/hooks/paymongo` route — and they must agree on every field down to
 * the event id, or the ledger dedupes one path and not the other. So neither of
 * them reads the envelope itself; both call this.
 *
 * Pure, dependency-free and total: it never throws, and an unrecognised body
 * comes back with empty fields rather than an exception. A parser that throws on
 * a shape change turns a merchandising oddity into a 500 and a PayMongo retry
 * storm.
 */

export const PAID_EVENT_TYPE = 'checkout_session.payment.paid'

export interface ParsedPaymongoEvent {
  /** PayMongo's `evt_…`. Empty string when the body does not carry one, which
   *  is the signal to reject rather than to invent an id. */
  eventId: string
  eventType: string
  livemode: boolean
  /** PayMongo's own checkout session, `cs_…`. */
  checkoutSessionId: string
  /** Medusa's payment session id, carried in metadata by `initiatePayment`. */
  paymentSessionId: string
  /** Medusa's cart id, carried the same way. The webhook's route to an order. */
  cartId: string
  reference: string
  paymongoPaymentId: string
  amountCentavos: number
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function parsePaymongoEvent(body: unknown): ParsedPaymongoEvent {
  const root: any = body ?? {}

  /**
   * PayMongo documents two payload shapes and they disagree about where the
   * event type lives — `data.attributes.type` in the events reference,
   * `data.type` in the Hosted Checkout docs. Reading only one is how a paid
   * order silently never gets fulfilled. Accept both.
   */
  const envelope = root?.data ?? root
  const attributes = envelope?.attributes ?? {}

  const eventType =
    attributes.type && attributes.type !== 'event' ? text(attributes.type) : text(envelope?.type)

  // The resource the event is ABOUT — the checkout session, not the event.
  const resource = attributes.data ?? envelope?.data ?? envelope
  const resourceAttributes = resource?.attributes ?? {}
  const metadata = resourceAttributes?.metadata ?? {}

  const payment = Array.isArray(resourceAttributes?.payments)
    ? resourceAttributes.payments[0]
    : undefined

  return {
    eventId: text(envelope?.id) || text(root?.id),
    eventType: eventType || 'unknown',
    livemode: Boolean(attributes?.livemode ?? resourceAttributes?.livemode ?? false),
    checkoutSessionId: text(resource?.id),
    paymentSessionId: text(metadata?.session_id),
    cartId: text(metadata?.cart_id),
    // Prefer the session's own reference_number; fall back to the copy we put
    // in metadata, which survives shapes where the former is absent.
    reference: text(resourceAttributes?.reference_number) || text(metadata?.reference),
    paymongoPaymentId: text(payment?.id),
    amountCentavos: Number(payment?.attributes?.amount ?? 0) || 0,
  }
}
