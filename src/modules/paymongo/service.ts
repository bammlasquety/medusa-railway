import { randomUUID } from 'node:crypto'

import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from '@medusajs/framework/types'
import { AbstractPaymentProvider, BigNumber, MedusaError } from '@medusajs/framework/utils'

import { PaymongoClient, verifyPaymongoSignature } from './client'

/**
 * PayMongo Hosted Checkout as a Medusa payment provider.
 *
 * The shape of this integration is decided by one fact: PayMongo Hosted Checkout
 * is a REDIRECT flow that CAPTURES immediately. There is no authorise-then-
 * capture window, and the customer is not present when the money moves.
 *
 * That produces two consequences that run through every method here:
 *
 *   - We report `captured`, never `authorized`. Reporting `authorized` would
 *     describe a state PayMongo does not have and leave Medusa waiting for a
 *     capture that can never happen.
 *
 *   - `authorizePayment` returns `pending` rather than throwing when the money
 *     has not landed yet. The docs call this deferred authorization, and it is
 *     what lets a buyer who returns a moment early see "confirming" instead of
 *     an error on a payment that did in fact work.
 *
 * See docs/adr/0002-paymongo-payment-provider.md.
 */

export interface PaymongoOptions {
  secretKey: string
  webhookSecret: string
  /** Absolute origin PayMongo returns the buyer to. Must match the origin they
   *  are browsing, or the storefront's claim cookie will not come back. */
  storefrontUrl: string
  paymentMethodTypes?: string[]
  /** Hosted Checkout only bills in PHP. */
  currency?: string
}

type InjectedDependencies = { logger: Logger }

const DEFAULT_METHODS = ['card', 'gcash', 'qrph', 'paymaya']

class PaymongoProviderService extends AbstractPaymentProvider<PaymongoOptions> {
  static identifier = 'paymongo'

  protected readonly logger_: Logger
  protected readonly client_: PaymongoClient

  constructor(container: InjectedDependencies, options: PaymongoOptions) {
    super(container, options)
    this.logger_ = container.logger
    this.client_ = new PaymongoClient(options.secretKey, container.logger)
  }

  static validateOptions(options: Record<any, any>) {
    for (const key of ['secretKey', 'webhookSecret', 'storefrontUrl']) {
      if (!options[key]) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `PayMongo provider requires \`${key}\`.`
        )
      }
    }
  }

  /**
   * Medusa works in decimal major units; PayMongo bills in centavos.
   *
   * `amount` arrives as `BigNumberInput`, which is a plain number SOMETIMES and
   * a BigNumber object the rest of the time. `Number({...})` on the object form
   * is `NaN`, and — this is the part that bites — `NaN <= 0` is `false`, so a
   * naive guard waves it straight through. PayMongo then receives a null amount,
   * rejects it, and the whole thing surfaces as Medusa's "An unknown error
   * occurred."
   *
   * So: unwrap the object forms, and validate with `isFinite` rather than a
   * comparison, because no comparison is true of NaN.
   */
  private toCentavos(amount: unknown): number {
    const raw = amount as any

    const numeric =
      raw !== null && typeof raw === 'object'
        ? Number(raw.numeric ?? raw.value ?? raw.raw?.value ?? raw.bigNumber?.numeric ?? NaN)
        : Number(raw)

    if (!Number.isFinite(numeric)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `PayMongo: could not read an amount from ${JSON.stringify(raw)}.`
      )
    }

    return Math.round(numeric * 100)
  }

  // -------------------------------------------------------------------------

  /**
   * Creates the Checkout Session and hands its URL back to the storefront.
   *
   * The Medusa payment session id is written into PayMongo's `metadata`, because
   * `getWebhookActionAndData` has nothing else to correlate on — the webhook
   * arrives with a PayMongo session and must find the Medusa one. If that id is
   * ever absent, the webhook path silently stops working while the fallback
   * still succeeds, which is the hardest kind of bug to notice. So it is logged
   * loudly rather than assumed.
   */
  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const options = this.options_
    const amountCentavos = this.toCentavos(input.amount)

    if (amountCentavos <= 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'PayMongo requires a positive amount.')
    }

    const currency = String(input.currency_code ?? options.currency ?? 'PHP').toUpperCase()
    if (currency !== 'PHP') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `PayMongo Hosted Checkout only bills in PHP; got ${currency}.`
      )
    }

    const sessionId = String((input.data as any)?.session_id ?? '')
    if (!sessionId) {
      this.logger_.warn(
        '[paymongo] initiatePayment received no session_id; the webhook will not be able to ' +
          'correlate this payment and authorisation will rely on the return-path fallback'
      )
    }

    const reference = `DND-${randomUUID().slice(0, 8).toUpperCase()}`
    const origin = options.storefrontUrl.replace(/\/$/, '')
    const context: any = input.context ?? {}

    try {
      return await this.createSession_(amountCentavos, reference, origin, context, sessionId)
    } catch (error) {
      /**
       * Any raw throw out of a provider method becomes Medusa's "An unknown
       * error occurred." at the storefront — a message that names neither the
       * system that failed nor why. Re-throwing as a MedusaError carries the
       * real cause all the way to the caller.
       */
      if (error instanceof MedusaError) throw error

      const detail = (error as Error)?.message ?? String(error)
      this.logger_.error(`[paymongo] initiatePayment failed: ${detail}`)

      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `PayMongo: ${detail}`)
    }
  }

  private async createSession_(
    amountCentavos: number,
    reference: string,
    origin: string,
    context: any,
    sessionId: string
  ): Promise<InitiatePaymentOutput> {
    const options = this.options_

    const session = await this.client_.createCheckoutSession({
      // One line item for the order total. Medusa already owns the basket, and
      // duplicating lines here would let the two disagree about what was bought.
      line_items: [
        { name: 'Order total', amount: amountCentavos, currency: 'PHP', quantity: 1 },
      ],
      payment_method_types: options.paymentMethodTypes ?? DEFAULT_METHODS,
      success_url: `${origin}/checkout/success?ref=${reference}`,
      cancel_url: `${origin}/checkout/cancelled?ref=${reference}`,
      reference_number: reference,
      send_email_receipt: true,
      metadata: {
        session_id: sessionId,
        reference,
        ...(context?.customer?.email ? { email: String(context.customer.email) } : {}),
      },
    })

    return {
      id: session.id,
      data: {
        id: session.id,
        // The storefront reads this to know where to redirect. It is the whole
        // point of the call.
        checkout_url: session.attributes.checkout_url,
        reference,
        session_id: sessionId,
        livemode: session.attributes.livemode,
      },
    }
  }

  /**
   * Asks PayMongo whether the money actually landed.
   *
   * Called by `completeCart`, so this runs on the buyer's return. It never
   * trusts that return — `success_url` is attacker-controllable and proves
   * nothing. PayMongo's own answer is the only input.
   */
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const sessionId = String((input.data as any)?.id ?? '')
    if (!sessionId) {
      return { status: 'error', data: input.data ?? {} }
    }

    try {
      const session = await this.client_.retrieveCheckoutSession(sessionId)
      const payment = await this.client_.findPaidPayment(session)

      if (!payment) {
        /**
         * Deferred authorization. The buyer may simply have arrived before
         * PayMongo finalised, or may have abandoned the hosted page entirely —
         * from here those look identical, and treating either as an error would
         * fail a payment that is about to succeed.
         */
        return { status: 'pending', data: { ...(input.data as object), id: sessionId } }
      }

      return {
        // Captured, not authorized: Hosted Checkout takes the money at once.
        status: 'captured',
        data: {
          ...(input.data as object),
          id: sessionId,
          payment_id: payment.id,
          amount_centavos: payment.amount,
          captured_at: new Date().toISOString(),
        },
      }
    } catch (error) {
      this.logger_.error(
        `[paymongo] authorize failed for ${sessionId}: ${(error as Error)?.message ?? error}`
      )
      // Pending, not error: a gateway blip must not condemn a real payment. The
      // next poll or the webhook will settle it.
      return { status: 'pending', data: input.data ?? {} }
    }
  }

  /** Already captured by PayMongo at the moment of payment. Returning the data
   *  unchanged is the honest answer; there is no second call to make. */
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const sessionId = String((input.data as any)?.id ?? '')
    if (!sessionId) return { status: 'pending' }

    try {
      const session = await this.client_.retrieveCheckoutSession(sessionId)
      const payment = await this.client_.findPaidPayment(session)

      if (payment) return { status: 'captured', data: { id: sessionId, payment_id: payment.id } }
      if (session.attributes.status === 'expired') return { status: 'canceled' }
      return { status: 'pending' }
    } catch {
      return { status: 'pending' }
    }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const sessionId = String((input.data as any)?.id ?? '')
    if (!sessionId) return { data: input.data ?? {} }

    const session = await this.client_.retrieveCheckoutSession(sessionId)
    return { data: session as unknown as Record<string, unknown> }
  }

  /** Nothing to update at PayMongo — a Checkout Session's amount is fixed once
   *  created. Medusa handles a changed basket by deleting the session and
   *  initiating a new one, which is the correct behaviour anyway. */
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    return { data: input.data ?? {} }
  }

  /**
   * Expiring at PayMongo is the ONLY thing that stops a session accepting
   * payment — they never expire on their own. Skipping it leaves a payable URL
   * for a basket Medusa has already moved on from.
   */
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const sessionId = String((input.data as any)?.id ?? '')
    if (!sessionId) return { data: input.data ?? {} }

    try {
      await this.client_.expireCheckoutSession(sessionId)
    } catch (error) {
      // Already paid or already expired both land here. Log, do not throw: a
      // failure to cancel must not block the cart operation that triggered it.
      this.logger_.warn(
        `[paymongo] could not expire ${sessionId}: ${(error as Error)?.message ?? error}`
      )
    }

    return { data: { ...(input.data as object), canceled_at: new Date().toISOString() } }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return this.cancelPayment(input as CancelPaymentInput)
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const paymentId = String((input.data as any)?.payment_id ?? '')

    if (!paymentId) {
      // Refusing beats pretending. A silent no-op here means an admin believes
      // they refunded a customer who never got their money.
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Cannot refund: no PayMongo payment id on this payment session.'
      )
    }

    const refund = await this.client_.refundPayment(paymentId, this.toCentavos(input.amount))

    return {
      data: {
        ...(input.data as object),
        refund_id: refund?.data?.id ?? null,
        refunded_at: new Date().toISOString(),
      },
    }
  }

  /**
   * Maps PayMongo's webhook onto Medusa's payment vocabulary.
   *
   * Medusa's built-in `POST /hooks/payment/paymongo` route calls this and then
   * applies the result to the payment session — so this method is a pure mapper
   * with one security responsibility: verify the signature before believing
   * anything in the body.
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload['payload']
  ): Promise<WebhookActionResult> {
    const nothing = { action: 'not_supported' as const }

    const rawBody =
      typeof payload.rawData === 'string'
        ? payload.rawData
        : Buffer.from(payload.rawData as any).toString('utf8')

    const signature = String(
      (payload.headers as any)?.['paymongo-signature'] ??
        (payload.headers as any)?.['Paymongo-Signature'] ??
        ''
    )

    if (
      !verifyPaymongoSignature({
        rawBody,
        signatureHeader: signature,
        secret: this.options_.webhookSecret,
      })
    ) {
      this.logger_.error('[paymongo] webhook signature rejected')
      return nothing
    }

    const body: any = payload.data ?? {}

    /**
     * PayMongo documents two payload shapes and they disagree about where the
     * event type lives — `data.attributes.type` in the events reference,
     * `data.type` in the Hosted Checkout docs. Reading only one is how a paid
     * order silently never gets fulfilled. Accept both.
     */
    const envelope = body?.data ?? body
    const attributes = envelope?.attributes ?? {}
    const eventType =
      attributes.type && attributes.type !== 'event' ? attributes.type : envelope?.type

    if (eventType !== 'checkout_session.payment.paid') return nothing

    const resource = attributes.data ?? envelope?.data ?? envelope
    const sessionId = String(resource?.attributes?.metadata?.session_id ?? '')
    const payment = resource?.attributes?.payments?.[0]
    const amountCentavos = Number(payment?.attributes?.amount ?? 0)

    if (!sessionId) {
      // No Medusa session id in metadata means this payment cannot be matched.
      // Returning not_supported (rather than failed) leaves the return-path
      // fallback free to authorise it.
      this.logger_.warn(
        '[paymongo] paid webhook carried no session_id in metadata; ' +
          'falling back to authorisation on return'
      )
      return nothing
    }

    return {
      action: 'captured',
      data: {
        session_id: sessionId,
        // Medusa compares this against the session amount, so it must be in the
        // same major units Medusa initiated with — not centavos.
        amount: new BigNumber(amountCentavos / 100),
      },
    }
  }
}

export default PaymongoProviderService
