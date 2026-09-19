/**
 * Writes to the storefront's `commerce_issues` table (storefront repo,
 * supabase/migrations/0007) so Medusa-side failures — a paid webhook that
 * cannot become an order, a digital delivery refused or not emailed — land in
 * the same queue as the storefront's, keyed by the same reference / cart id.
 *
 * Uses this lane's SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — the same
 * storefront project the digital files live in. COMMERCE_ISSUES_SUPABASE_URL /
 * COMMERCE_ISSUES_SUPABASE_KEY override them only if the log ever needs to
 * live elsewhere.
 *
 * Unconfigured, issues go to the Medusa log only. NEVER THROWS.
 */

type Severity = 'info' | 'warning' | 'error' | 'critical'

export interface CommerceIssue {
  stage:
    | 'payment'
    | 'payment_confirmation'
    | 'order'
    | 'fulfilment'
    | 'download'
    | 'webhook'
    | 'other'
  code: string
  message: string
  severity?: Severity
  reference?: string | null
  cartId?: string | null
  orderId?: string | null
  customerId?: string | null
  email?: string | null
  paymentSessionId?: string | null
  paymongoSessionId?: string | null
  paymongoPaymentId?: string | null
  amountCentavos?: number | null
  context?: Record<string, unknown>
  fingerprint?: string
}

interface Logger {
  error(message: string): void
  warn(message: string): void
}

const TIMEOUT_MS = 3000

function config() {
  const url = String(
    process.env.COMMERCE_ISSUES_SUPABASE_URL || process.env.SUPABASE_URL || ''
  ).replace(/\/$/, '')
  const key = String(
    process.env.COMMERCE_ISSUES_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  )
  return url && key ? { url, key } : null
}

function headers(key: string): Record<string, string> {
  return {
    apikey: key,
    ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
    'Content-Type': 'application/json',
  }
}

export async function logCommerceIssue(logger: Logger | undefined, issue: CommerceIssue): Promise<void> {
  const severity = issue.severity ?? 'error'
  const line = `[issue] ${severity} ${issue.stage}/${issue.code}: ${issue.message}`
  if (severity === 'critical' || severity === 'error') logger?.error(line)
  else logger?.warn(line)

  const target = config()
  if (!target) return

  const p = {
    source: 'medusa',
    stage: issue.stage,
    code: issue.code,
    severity,
    message: String(issue.message ?? '').slice(0, 2000),
    reference: issue.reference || null,
    cart_id: issue.cartId || null,
    order_id: issue.orderId || null,
    customer_id: issue.customerId || null,
    email: issue.email || null,
    payment_session_id: issue.paymentSessionId || null,
    paymongo_session_id: issue.paymongoSessionId || null,
    paymongo_payment_id: issue.paymongoPaymentId || null,
    amount_centavos: issue.amountCentavos ?? null,
    currency: 'PHP',
    environment: process.env.APP_ENV || process.env.NODE_ENV || 'unknown',
    context: issue.context ?? {},
    ...(issue.fingerprint ? { fingerprint: issue.fingerprint } : {}),
  }

  try {
    const response = await fetch(`${target.url}/rest/v1/rpc/log_commerce_issue`, {
      method: 'POST',
      headers: headers(target.key),
      body: JSON.stringify({ p }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) logger?.warn(`[issue] could not record issue (${response.status})`)
  } catch (error) {
    logger?.warn(`[issue] could not record issue: ${(error as Error)?.message ?? error}`)
  }
}

/**
 * Marks open issues for a cart as resolved once its order exists — the
 * "confirming…" warnings that preceded it are history, not work.
 */
export async function resolveCommerceIssuesForCart(
  logger: Logger | undefined,
  cartId: string,
  orderId: string
): Promise<void> {
  const target = config()
  if (!target || !cartId) return

  try {
    const response = await fetch(
      `${target.url}/rest/v1/commerce_issues?cart_id=eq.${encodeURIComponent(cartId)}` +
        '&status=in.(open,acknowledged)&stage=in.(payment_confirmation,order,webhook)',
      {
        method: 'PATCH',
        headers: headers(target.key),
        body: JSON.stringify({
          status: 'resolved',
          resolved_at: new Date().toISOString(),
          resolved_by: 'system',
          resolution_note: `Order ${orderId} created`,
          order_id: orderId,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    )
    if (!response.ok) logger?.warn(`[issue] could not resolve issues for ${cartId} (${response.status})`)
  } catch (error) {
    logger?.warn(`[issue] could not resolve issues for ${cartId}: ${(error as Error)?.message ?? error}`)
  }
}
