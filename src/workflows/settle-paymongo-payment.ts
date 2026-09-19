import { Modules } from '@medusajs/framework/utils'
import { completeCartWorkflow } from '@medusajs/medusa/core-flows'
import {
  StepResponse,
  WorkflowResponse,
  createStep,
  createWorkflow,
  transform,
} from '@medusajs/framework/workflows-sdk'

import { parsePaymongoEvent } from '../modules/paymongo/event-payload'
import { PAYMONGO_LEDGER_MODULE } from '../modules/paymongo-ledger'
import type PaymongoLedgerService from '../modules/paymongo-ledger/service'
import { logCommerceIssue, resolveCommerceIssuesForCart } from '../lib/commerce-issues'

/**
 * Turns a claimed PayMongo event into an order.
 *
 * This is the half of the payment path that used to depend on the buyer's
 * browser coming back. It no longer does: the webhook is the trigger and the
 * queue is the transport, so a customer who pays and immediately closes the tab
 * gets the same order as one who waits for the success page.
 *
 * WHAT THIS DOES NOT DO is trust the webhook. The body is signed, so we believe
 * it is really PayMongo — but "PayMongo said this event happened" is not the
 * same claim as "this cart is paid for", and only the second one may create an
 * order. `completeCartWorkflow` calls the provider's `authorizePayment`, which
 * asks PayMongo's API directly about the session. The webhook decides WHEN to
 * look; PayMongo's API decides WHAT is true. That separation is the whole reason
 * a replayed or forged-but-signed body cannot manufacture a free order.
 */

interface SettleInput {
  ledgerId: string
}

// ---------------------------------------------------------------------------

/**
 * Takes ownership of the claim and reads back the payload.
 *
 * The queue message carries only the ledger id. The payload comes from the
 * database, so a message that is redelivered after the row has moved on cannot
 * act on stale data.
 */
const loadClaimStep = createStep(
  'load-paymongo-claim',
  async (input: SettleInput, { container }) => {
    const ledger = container.resolve(PAYMONGO_LEDGER_MODULE) as PaymongoLedgerService

    const row = await ledger.retrievePaymongoEvent(input.ledgerId)

    if (!row) {
      return new StepResponse({ row: null, event: null, skip: true, reason: 'no ledger row' })
    }

    /**
     * Already finished. A duplicate queue message for a processed event is
     * normal — BullMQ guarantees at-least-once, not exactly-once — and the
     * correct response to it is silence.
     */
    if (String((row as any).status) === 'processed') {
      return new StepResponse({ row, event: null, skip: true, reason: 'already processed' })
    }

    await ledger.markProcessing(input.ledgerId, Number((row as any).attempts ?? 0))

    return new StepResponse({
      row,
      event: parsePaymongoEvent((row as any).payload),
      skip: false,
      reason: '',
    })
  }
)

/**
 * Completes the cart, which is what actually verifies the payment.
 *
 * Every failure mode here is caught and classified rather than thrown, because
 * the caller needs to record WHY on the ledger row. A step that throws loses
 * that: the workflow unwinds, the subscriber logs a stack trace, and the row
 * says nothing except that something went wrong.
 */
const ensureOrderStep = createStep(
  'ensure-order-for-paymongo-payment',
  async (
    input: { cartId: string; reference: string; skip: boolean },
    { container }
  ) => {
    if (input.skip) return new StepResponse({ orderId: '', state: 'skipped', reason: '' })

    const logger = container.resolve('logger') as any

    if (!input.cartId) {
      /**
       * No cart id in the PayMongo metadata. Only possible for a session created
       * before `initiatePayment` started carrying one — those are all long since
       * completed by the return path, so this is a terminal classification
       * rather than something to retry forever.
       */
      return new StepResponse({
        orderId: '',
        state: 'unrecoverable',
        reason: 'no cart_id in PayMongo metadata (session predates webhook-driven completion)',
      })
    }

    try {
      const { result } = await completeCartWorkflow(container).run({
        input: { id: input.cartId },
      })

      const orderId = String((result as any)?.id ?? '')

      if (!orderId) {
        return new StepResponse({
          orderId: '',
          state: 'pending',
          reason: 'cart.complete returned no order id',
        })
      }

      logger.info(
        `[paymongo] completed cart ${input.cartId} from webhook (${input.reference}) -> ${orderId}`
      )

      return new StepResponse({ orderId, state: 'order', reason: '' })
    } catch (error) {
      const reason = String((error as any)?.message ?? error)

      /**
       * The same classification the storefront's `tryCompleteCart` uses, and for
       * the same reason: "payment sessions are not authorized" is what Medusa
       * says both while PayMongo is still finalising AND when the buyer never
       * paid. Treating it as a hard failure would give up on a payment that is
       * seconds from landing, so it stays retryable and the reconcile job looks
       * again.
       *
       * An already-completed cart is a SUCCESS with nothing left to do — a
       * racing return-path completion got there first, which is exactly the
       * outcome both paths exist to produce.
       */
      if (/already completed|already an order/i.test(reason)) {
        return new StepResponse({ orderId: '', state: 'already', reason })
      }

      const pending = /payment|authoriz|authoris|not.*paid|pending/i.test(reason)

      return new StepResponse({
        orderId: '',
        state: pending ? 'pending' : 'error',
        reason,
      })
    }
  }
)

/**
 * Writes the PayMongo coordinates onto the order.
 *
 * Reconciling a bank statement, a PayMongo dashboard row and a Medusa order used
 * to mean joining three systems by amount and timestamp. After this it is one
 * lookup on `metadata.paymongo_reference`, from the admin UI, by someone who
 * does not have database access.
 *
 * Best effort on purpose: an order that exists but is missing a trace field is a
 * bookkeeping problem, and it must never be the reason a paid order is retried.
 */
const stampPaymongoTraceStep = createStep(
  'stamp-paymongo-trace',
  async (
    input: {
      orderId: string
      reference: string
      checkoutSessionId: string
      paymongoPaymentId: string
      eventId: string
      livemode: boolean
    },
    { container }
  ) => {
    if (!input.orderId) return new StepResponse(void 0)

    const logger = container.resolve('logger') as any

    try {
      const query = container.resolve('query')

      const { data: [order] } = await query.graph({
        entity: 'order',
        fields: ['id', 'metadata'],
        filters: { id: input.orderId },
      })

      const orderModule = container.resolve(Modules.ORDER) as any

      await orderModule.updateOrders([
        {
          id: input.orderId,
          metadata: {
            ...((order as any)?.metadata ?? {}),
            paymongo_reference: input.reference || null,
            paymongo_checkout_session_id: input.checkoutSessionId || null,
            paymongo_payment_id: input.paymongoPaymentId || null,
            paymongo_event_id: input.eventId || null,
            paymongo_livemode: input.livemode,
          },
        },
      ])
    } catch (error) {
      logger.warn(
        `[paymongo] could not stamp trace metadata on ${input.orderId}: ` +
          `${(error as Error)?.message ?? error}`
      )
    }

    return new StepResponse(void 0)
  }
)

/** Closes the ledger row. The last thing that happens, so that a crash anywhere
 *  above leaves the claim in a state the reconcile job will re-drive. */
const settleClaimStep = createStep(
  'settle-paymongo-claim',
  async (
    input: {
      ledgerId: string
      orderId: string
      state: string
      reason: string
      paymongoPaymentId: string
      cartId: string
      reference: string
      checkoutSessionId: string
    },
    { container }
  ) => {
    const ledger = container.resolve(PAYMONGO_LEDGER_MODULE) as PaymongoLedgerService
    const logger = container.resolve('logger') as any

    if (input.state === 'skipped') return new StepResponse(void 0)

    if (input.state === 'order' || input.state === 'already') {
      await ledger.markProcessed(input.ledgerId, {
        orderId: input.orderId || null,
        paymongoPaymentId: input.paymongoPaymentId || null,
      })
      if (input.orderId) await resolveCommerceIssuesForCart(logger, input.cartId, input.orderId)
      return new StepResponse(void 0)
    }

    const terminal = input.state === 'unrecoverable'

    logger[terminal ? 'error' : 'warn'](
      `[paymongo] event ${input.ledgerId} not settled (${input.state}): ${input.reason}`
    )

    await ledger.markFailed(input.ledgerId, `${input.state}: ${input.reason}`, !terminal)

    /**
     * PayMongo said PAID and there is still no order. `pending` is usually a
     * payment PayMongo has not finalised (QR Ph) and is retried; `error` is a
     * cart Medusa refuses to complete (e.g. no shipping method can carry an
     * item) and will not fix itself — money has moved, so it is critical.
     */
    await logCommerceIssue(logger, {
      stage: input.state === 'pending' ? 'payment_confirmation' : 'order',
      code:
        input.state === 'pending'
          ? 'payment_confirmation.webhook_pending'
          : terminal
            ? 'webhook.unrecoverable'
            : 'order.completion_failed',
      severity: input.state === 'pending' ? 'warning' : 'critical',
      message: `Paid webhook did not produce an order (${input.state}): ${input.reason}`,
      reference: input.reference,
      cartId: input.cartId,
      paymongoSessionId: input.checkoutSessionId,
      paymongoPaymentId: input.paymongoPaymentId,
      context: { ledger_id: input.ledgerId },
    })

    return new StepResponse(void 0)
  }
)

// ---------------------------------------------------------------------------

export const settlePaymongoPaymentWorkflow = createWorkflow(
  'settle-paymongo-payment',
  (input: SettleInput) => {
    const claim = loadClaimStep(input)

    const completion = ensureOrderStep(
      transform({ claim }, (data) => ({
        cartId: String((data.claim as any)?.event?.cartId ?? ''),
        reference: String((data.claim as any)?.event?.reference ?? ''),
        skip: Boolean((data.claim as any)?.skip),
      }))
    )

    stampPaymongoTraceStep(
      transform({ claim, completion }, (data) => ({
        orderId: String((data.completion as any)?.orderId ?? ''),
        reference: String((data.claim as any)?.event?.reference ?? ''),
        checkoutSessionId: String((data.claim as any)?.event?.checkoutSessionId ?? ''),
        paymongoPaymentId: String((data.claim as any)?.event?.paymongoPaymentId ?? ''),
        eventId: String((data.claim as any)?.event?.eventId ?? ''),
        livemode: Boolean((data.claim as any)?.event?.livemode),
      }))
    )

    settleClaimStep(
      transform({ input, claim, completion }, (data) => ({
        ledgerId: data.input.ledgerId,
        orderId: String((data.completion as any)?.orderId ?? ''),
        state: String((data.completion as any)?.state ?? 'skipped'),
        reason: String((data.completion as any)?.reason ?? ''),
        paymongoPaymentId: String((data.claim as any)?.event?.paymongoPaymentId ?? ''),
        cartId: String((data.claim as any)?.event?.cartId ?? ''),
        reference: String((data.claim as any)?.event?.reference ?? ''),
        checkoutSessionId: String((data.claim as any)?.event?.checkoutSessionId ?? ''),
      }))
    )

    return new WorkflowResponse(completion)
  }
)

export default settlePaymongoPaymentWorkflow
