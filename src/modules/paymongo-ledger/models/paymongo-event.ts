import { model } from '@medusajs/framework/utils'

/**
 * One row per PayMongo webhook delivery we have accepted responsibility for.
 *
 * This table is the idempotency key of the whole payment path. PayMongo signs an
 * event once and redelivers that same event up to twelve times with backoff, and
 * two Medusa instances behind Railway's load balancer can be handed the same
 * retry at the same instant. "Check, then insert" loses that race; a unique
 * index does not, because the decision is made by Postgres under a row lock
 * rather than by two processes that both read `null`.
 *
 * It is deliberately a WRITE-AHEAD record, not an audit log written afterwards.
 * The row is created before any order work happens and is only marked
 * `processed` once that work is done, so a worker that dies mid-flight leaves a
 * row that still says `processing` — which is exactly what the reconcile job
 * looks for. An audit log written at the end would leave nothing behind at all.
 *
 * `payload` is the raw signed body. Storing it means a failed event can be
 * replayed from here without asking PayMongo to redeliver, which they will only
 * do for a limited window.
 */
export const PaymongoEvent = model
  .define(
    { name: 'paymongo_event', tableName: 'paymongo_events' },
    {
      id: model.id({ prefix: 'pmevt' }).primaryKey(),

      /** PayMongo's own `evt_…` id. The claim is made on this column. */
      event_id: model.text(),
      event_type: model.text(),
      livemode: model.boolean().default(false),

      /**
       * claimed    — inserted, not yet picked up by a worker
       * processing — a worker has it
       * processed  — order work finished
       * failed     — the worker gave up; needs a human or a replay
       * ignored    — an event type we do not act on, kept for the history
       *
       * Plain text rather than a Postgres enum: adding a state later should be a
       * code change, not a migration on a table the payment path writes to.
       */
      status: model.text().default('claimed'),
      attempts: model.number().default(0),
      last_error: model.text().nullable(),

      /**
       * Denormalised correlation columns. They are all derivable from `payload`,
       * and they are here anyway because the question you ask this table at 2am
       * is "what happened to reference DND-50C69726", and that must not require
       * a JSON scan.
       */
      reference: model.text().nullable(),
      cart_id: model.text().nullable(),
      payment_session_id: model.text().nullable(),
      paymongo_payment_id: model.text().nullable(),
      order_id: model.text().nullable(),

      payload: model.json(),
      processed_at: model.dateTime().nullable(),
    }
  )
  .indexes([
    /**
     * NO `where: 'deleted_at IS NULL'` here, unlike DigitalGrant.
     *
     * That clause is right for a grant, where a soft-deleted row should not
     * block a legitimate re-grant. It is wrong for an idempotency claim: soft
     * deleting a processed event must not make the same payment processable a
     * second time. The claim outlives the row's visibility on purpose.
     */
    { on: ['event_id'], unique: true },
    { on: ['status'] },
    { on: ['reference'] },
    { on: ['order_id'] },
  ])

export default PaymongoEvent
