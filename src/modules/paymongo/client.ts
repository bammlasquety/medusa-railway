import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * PayMongo HTTP client.
 *
 * Ported from the storefront implementation, including the version fallback
 * below — that behaviour was found the hard way and is the most important thing
 * in this file.
 */

const API_ROOT = 'https://api.paymongo.com'
const REQUEST_TIMEOUT_MS = 10_000

/**
 * PayMongo's two API versions do not expose the same routes.
 *
 * `POST /v2/checkout_sessions` creates fine, but `GET /v2/checkout_sessions/:id`
 * answers `404 {"code":"not_found","detail":"The requested route does not
 * exist"}` — the reads still live on v1. The reference docs are client-rendered
 * and return nothing to a fetch, so this is not discoverable without trying it.
 *
 * Reads try v2, fall back to v1 on a ROUTE-level 404 only, and cache the winner
 * per path shape: one wasted call per process, not per request. A missing object
 * or a bad key breaks out immediately, because turning a clear error into a
 * confusing one is worse than the wasted call.
 */
const READ_VERSIONS = ['v2', 'v1'] as const

export interface PaymongoLineItem {
  name: string
  amount: number
  currency: 'PHP'
  quantity: number
}

export interface PaymongoSession {
  id: string
  attributes: {
    checkout_url: string
    livemode: boolean
    reference_number?: string
    status?: string
    payments?: PaymongoPaymentRef[]
    payment_intent?: {
      id?: string
      attributes?: { status?: string; payments?: PaymongoPaymentRef[] }
    } | null
    metadata?: Record<string, string>
  }
}

export interface PaymongoPaymentRef {
  id: string
  attributes?: { status?: string; amount?: number }
}

export class PaymongoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = 'PaymongoApiError'
  }
}

export class PaymongoClient {
  private readonly resolvedVersion = new Map<string, string>()

  constructor(
    private readonly secretKey: string,
    private readonly logger: { info(m: string): void; warn(m: string): void }
  ) {
    if (!secretKey) throw new Error('PayMongo provider requires `secretKey`.')
  }

  /** Basic auth, secret key as username, empty password — hence the trailing colon. */
  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`
  }

  private async request(version: string, path: string, init: RequestInit = {}) {
    const response = await fetch(`${API_ROOT}/${version}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      // A gateway that stops answering must not hang checkout.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    const json: any = await response.json().catch(() => null)
    const detail = String(json?.errors?.[0]?.detail ?? '')

    return {
      ok: response.ok,
      status: response.status,
      json,
      detail,
      code: json?.errors?.[0]?.code as string | undefined,
      routeMissing: response.status === 404 && /route does not exist/i.test(detail),
    }
  }

  /** Pinned to v2. Creation works there, and the call that takes money is not
   *  one to add retry logic to. */
  private async createOnV2(path: string, body: unknown) {
    const result = await this.request('v2', path, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    if (!result.ok) {
      throw new PaymongoApiError(
        result.detail || `PayMongo ${result.status}`,
        result.status,
        result.code
      )
    }

    return result.json
  }

  private async versioned(key: string, path: string, init: RequestInit = {}) {
    const known = this.resolvedVersion.get(key)
    const versions = known ? [known] : READ_VERSIONS

    let last: Awaited<ReturnType<typeof this.request>> | null = null

    for (const version of versions) {
      const result = await this.request(version, path, init)

      if (result.ok) {
        if (!known) {
          this.resolvedVersion.set(key, version)
          this.logger.info(`[paymongo] using ${version} for ${key}`)
        }
        return result.json
      }

      last = result
      if (!result.routeMissing) break
    }

    throw new PaymongoApiError(
      last!.detail || `PayMongo ${last!.status}`,
      last!.status,
      last!.code
    )
  }

  async createCheckoutSession(attributes: {
    line_items: PaymongoLineItem[]
    payment_method_types: string[]
    success_url: string
    cancel_url: string
    reference_number: string
    description?: string
    send_email_receipt?: boolean
    metadata?: Record<string, string>
  }): Promise<PaymongoSession> {
    const json = await this.createOnV2('/checkout_sessions', { data: { attributes } })
    return json.data as PaymongoSession
  }

  async retrieveCheckoutSession(sessionId: string): Promise<PaymongoSession> {
    const json = await this.versioned('checkout_sessions', `/checkout_sessions/${sessionId}`)
    return json.data as PaymongoSession
  }

  async retrievePayment(paymentId: string): Promise<{
    id: string
    attributes?: { status?: string; amount?: number }
  }> {
    const json = await this.versioned('payments', `/payments/${paymentId}`)
    return json.data
  }

  async retrievePaymentIntent(intentId: string): Promise<{
    id: string
    attributes?: { status?: string; payments?: PaymongoPaymentRef[] }
  }> {
    const json = await this.versioned('payment_intents', `/payment_intents/${intentId}`)
    return json.data
  }

  /**
   * Checkout Sessions never expire on their own — this call is the only thing
   * that stops one accepting payment.
   */
  async expireCheckoutSession(sessionId: string) {
    return this.versioned(
      'checkout_sessions_expire',
      `/checkout_sessions/${sessionId}/expire`,
      { method: 'POST' }
    )
  }

  async refundPayment(paymentId: string, amountCentavos: number, reason = 'requested_by_customer') {
    return this.createOnV2('/refunds', {
      data: { attributes: { amount: amountCentavos, payment_id: paymentId, reason } },
    })
  }

  /**
   * Finds an actually-paid payment on a session, or null.
   *
   * Two traps, both from the docs:
   *
   *   1. A Checkout Session's own `status` is only ever "active" or "expired".
   *      It NEVER says "paid", so reading it returns "active" on a fully paid
   *      session — the exact wrong answer.
   *   2. Presence in `payments[]` is not proof either; a session can carry a
   *      failed attempt. PayMongo's reconciliation guide says to retrieve the
   *      Payment to confirm.
   *
   * So: trust an embedded status when there is one, retrieve the payment when
   * there is not.
   */
  async findPaidPayment(
    session: PaymongoSession | null | undefined
  ): Promise<{ id: string; amount: number } | null> {
    /**
     * Payments can live in two places, and QR Ph proved it.
     *
     * Card and e-wallet payments show up on the Checkout Session's own
     * `payments[]`. A QR Ph payment settles asynchronously: the session's
     * `payments[]` can stay EMPTY while the money sits on the session's
     * Payment Intent — `checkout_session.payment.paid` for
     * cs_ad3fb27606ab725f4c2cba9a arrived with `payments: []` and the intent
     * `processing`. Reading only the session made every QR Ph order look
     * unpaid forever, and the success page spun on money that had moved.
     *
     * So: the session's payments, then the intent's embedded payments, then —
     * if both are empty — the intent itself, fetched fresh.
     */
    const intent = session?.attributes?.payment_intent
    let payments: PaymongoPaymentRef[] = [
      ...(session?.attributes?.payments ?? []),
      ...(intent?.attributes?.payments ?? []),
    ]

    if (!payments.length && intent?.id) {
      try {
        const fresh = await this.retrievePaymentIntent(String(intent.id))
        payments = fresh?.attributes?.payments ?? []
        if (!payments.length) {
          this.logger.info(
            `[paymongo] session ${session?.id}: intent ${intent.id} is ` +
              `${fresh?.attributes?.status ?? 'unknown'} with no payments yet`
          )
        }
      } catch (error) {
        this.logger.warn(
          `[paymongo] could not retrieve intent ${intent.id}: ${(error as Error)?.message ?? error}`
        )
      }
    }

    if (!payments.length) return null

    for (const candidate of payments) {
      const id = String(candidate?.id ?? '')
      if (!id) continue

      const embedded = candidate?.attributes?.status ?? (candidate as any)?.status

      if (embedded) {
        if (embedded === 'paid') {
          return { id, amount: Number(candidate?.attributes?.amount ?? 0) }
        }
        continue
      }

      const payment = await this.retrievePayment(id)
      if (payment?.attributes?.status === 'paid') {
        return { id, amount: Number(payment.attributes?.amount ?? 0) }
      }
    }

    // Payments exist but none is paid. Legitimate (a failed card), but also what
    // a shape mismatch looks like — log the STRUCTURE, never the values.
    this.logger.info(
      `[paymongo] session ${session?.id} has ${payments.length} payment(s), none paid; ` +
        `keys=${Object.keys(payments[0] ?? {}).join('|')} ` +
        `attrs=${Object.keys(payments[0]?.attributes ?? {}).join('|')}`
    )

    return null
  }
}

/**
 * Verifies a PayMongo webhook signature.
 *
 * Header shape: `t=<unix>,te=<hex>,li=<hex>` — `te` is test mode, `li` is live.
 *
 * The 24-hour tolerance is deliberate and not a mistake. PayMongo signs an event
 * once and redelivers that same signed payload up to twelve times with backoff,
 * so a legitimate retry can arrive hours after its timestamp; the usual 5-minute
 * window rejects PayMongo's own retries as replays and the order never gets
 * paid. Replay protection comes from Medusa's payment session being idempotent,
 * not from this bound.
 */
export function verifyPaymongoSignature(opts: {
  rawBody: string
  signatureHeader: string
  secret: string
  toleranceSeconds?: number
  nowSeconds?: number
}): boolean {
  const tolerance = opts.toleranceSeconds ?? 60 * 60 * 24
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)

  if (!opts.signatureHeader || !opts.secret) return false

  const parts: Record<string, string> = {}
  for (const part of opts.signatureHeader.split(',')) {
    const [key, value] = part.split('=')
    if (key && value) parts[key.trim()] = value.trim()
  }

  const timestamp = Number(parts.t)
  if (!Number.isFinite(timestamp)) return false
  if (Math.abs(now - timestamp) > tolerance) return false

  const expected = createHmac('sha256', opts.secret)
    .update(`${timestamp}.${opts.rawBody}`)
    .digest('hex')

  // Constant time — `===` on a hex digest leaks timing information.
  return [parts.te, parts.li].some((candidate) => {
    if (!candidate) return false
    const a = Buffer.from(candidate, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  })
}
