import { MedusaService } from '@medusajs/framework/utils'

import { PaymongoEvent } from './models/paymongo-event'

/**
 * The idempotency ledger for PayMongo webhook deliveries.
 *
 * Its entire public contract is `claim()`. Everything else is bookkeeping about
 * a claim that has already been made.
 */

/** Postgres: unique_violation. */
const UNIQUE_VIOLATION = '23505'

export interface ClaimInput {
  eventId: string
  eventType: string
  livemode: boolean
  payload: unknown
  reference?: string | null
  cartId?: string | null
  paymentSessionId?: string | null
  paymongoPaymentId?: string | null
  /** An event type we record but never act on. Claimed and closed in one step. */
  ignored?: boolean
}

/**
 * Flat rather than a discriminated union, matching the reasoning in
 * DigitalDeliveryModuleService: this project compiles with `"strict": false`,
 * so TypeScript will not narrow a union on a boolean literal and callers would
 * not compile.
 */
export interface ClaimResult {
  /** True only for the caller that actually inserted the row. */
  claimed: boolean
  /** The ledger row id, whoever owns it. Null only if the row vanished between
   *  the failed insert and the read, which should not happen. */
  id: string | null
  status: string
}

/**
 * MikroORM wraps driver errors, and which wrapper you get depends on the driver
 * version — so this checks the shape rather than the class. A duplicate key is
 * the ONE error `claim()` is allowed to swallow; anything else must surface,
 * because silently treating a connection failure as "already claimed" would drop
 * a paid order on the floor.
 */
function isUniqueViolation(error: unknown): boolean {
  const err = error as any

  const codes = [err?.code, err?.cause?.code, err?.previous?.code, err?.originalError?.code]
  if (codes.some((code) => String(code ?? '') === UNIQUE_VIOLATION)) return true

  if (String(err?.name ?? '').includes('UniqueConstraintViolation')) return true

  const message = String(err?.message ?? '').toLowerCase()
  return message.includes('duplicate key value') || message.includes('unique constraint')
}

class PaymongoLedgerService extends MedusaService({ PaymongoEvent }) {
  /**
   * Claims an event, exactly once, across every process and every retry.
   *
   * This is `insert … on conflict (event_id) do nothing` expressed through the
   * methods `MedusaService` generates. The guarantee is identical — the unique
   * index on `event_id` is what makes the decision, in Postgres, under a row
   * lock — and it is written this way for a reason recorded in
   * DigitalDeliveryModuleService: `model.define()` returns a Medusa DML
   * definition rather than a MikroORM entity, so reaching past the generated
   * methods to the entity manager is how the last attempt at a clever
   * conditional write ended up not running at all.
   *
   * The caller MUST treat `claimed: false` as "someone else owns this" and do
   * nothing but return 200. It is not an error and must not be logged as one:
   * PayMongo retrying twelve times is normal operation, not an incident.
   */
  async claim(input: ClaimInput): Promise<ClaimResult> {
    const eventId = String(input.eventId ?? '').trim()

    if (!eventId) {
      throw new Error('PaymongoLedgerService.claim requires an event id.')
    }

    const status = input.ignored ? 'ignored' : 'claimed'

    try {
      const created = await this.createPaymongoEvents([
        {
          event_id: eventId,
          event_type: String(input.eventType ?? 'unknown'),
          livemode: Boolean(input.livemode),
          status,
          attempts: 0,
          reference: input.reference ?? null,
          cart_id: input.cartId ?? null,
          payment_session_id: input.paymentSessionId ?? null,
          paymongo_payment_id: input.paymongoPaymentId ?? null,
          order_id: null,
          payload: (input.payload ?? {}) as Record<string, unknown>,
          processed_at: input.ignored ? new Date() : null,
        },
      ])

      const row = Array.isArray(created) ? created[0] : created

      return { claimed: true, id: String((row as any)?.id ?? ''), status }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error

      const [existing] = await this.listPaymongoEvents({ event_id: eventId }, { take: 1 })

      return {
        claimed: false,
        id: existing ? String((existing as any).id) : null,
        status: existing ? String((existing as any).status) : 'claimed',
      }
    }
  }

  /** Marks a claim as picked up and counts the attempt. The counter is what
   *  stops the reconcile job replaying a poisoned event forever. */
  async markProcessing(id: string, currentAttempts: number): Promise<void> {
    await this.updatePaymongoEvents({
      id,
      status: 'processing',
      attempts: Number(currentAttempts ?? 0) + 1,
    })
  }

  async markProcessed(
    id: string,
    trace: { orderId?: string | null; paymongoPaymentId?: string | null } = {}
  ): Promise<void> {
    await this.updatePaymongoEvents({
      id,
      status: 'processed',
      processed_at: new Date(),
      last_error: null,
      ...(trace.orderId ? { order_id: trace.orderId } : {}),
      ...(trace.paymongoPaymentId ? { paymongo_payment_id: trace.paymongoPaymentId } : {}),
    })
  }

  /**
   * `retryable: false` is a terminal verdict — the reconcile job will not pick
   * the row up again. Reserve it for causes a replay cannot fix (a cart that no
   * longer exists), never for a timeout.
   */
  async markFailed(id: string, message: string, retryable = true): Promise<void> {
    await this.updatePaymongoEvents({
      id,
      status: retryable ? 'claimed' : 'failed',
      last_error: String(message ?? '').slice(0, 1000),
    })
  }

  /**
   * Claims that were never carried to completion — a worker that was redeployed
   * mid-event, a Redis blip that lost the job, an enqueue that threw after the
   * row was written.
   *
   * Without this the write-ahead row is just a comment. With it, "we accepted
   * this payment" is a promise the system keeps by itself.
   */
  async listStuck(olderThan: Date, maxAttempts: number, limit = 50): Promise<any[]> {
    return await this.listPaymongoEvents(
      {
        status: ['claimed', 'processing'],
        attempts: { $lt: maxAttempts },
        updated_at: { $lt: olderThan },
      },
      { take: limit, order: { updated_at: 'ASC' } }
    )
  }
}

export default PaymongoLedgerService
