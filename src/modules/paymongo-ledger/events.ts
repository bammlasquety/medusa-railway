/**
 * The queue boundary.
 *
 * The webhook route emits this and returns 200; a subscriber consumes it and
 * does the order work. With `@medusajs/event-bus-redis` registered, Medusa's
 * event bus IS a BullMQ queue on Redis — durable, with retries and backoff, and
 * consumed by the worker process rather than the web process. Emitting an event
 * therefore buys the async queue without a second queue library, a second Redis
 * pool, or a lifecycle to own.
 *
 * WITHOUT that module registered Medusa falls back to an in-memory bus, and this
 * becomes a `setImmediate` that a redeploy silently drops. See the config notes
 * in the README: registering the Redis modules is not optional here.
 */
export const PAYMONGO_EVENT_RECEIVED = 'paymongo.event.received'

export interface PaymongoEventReceived {
  /** The ledger row id, not PayMongo's event id. The payload the worker needs
   *  is already in the database; putting it on the queue as well would let the
   *  two disagree. */
  ledger_id: string
}
