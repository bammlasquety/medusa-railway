import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'

import { isTrustedStorefront } from '../../../../lib/storefront-guard'
import { sendEmail } from '../../../../lib/send-email'
import { PASSWORD_RESET_MODULE } from '../../../../modules/password-reset'
import { passwordChanged } from '../../../../modules/resend/templates/password-reset'
import { isResettableCustomer, normaliseEmail } from '../_eligibility'

const MESSAGES: Record<string, string> = {
  invalid: 'That code is incorrect or has expired.',
  expired: 'That code has expired. Request a new one.',
  locked: 'Too many incorrect attempts. Request a new code.',
}

/**
 * POST /store/password-reset/confirm  { email, code, password }
 *
 * Verifies the PIN and, only then, sets the new password on the customer's
 * emailpass identity. Wrong-PIN answers do not reveal whether the email has an
 * account. Only the storefront server may call it.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  if (!isTrustedStorefront(req)) return res.status(403).json({ message: 'Forbidden' })

  const logger = req.scope.resolve('logger') as any
  const body = (req.body ?? {}) as Record<string, unknown>
  const email = normaliseEmail(body.email)
  const code = String(body.code ?? '').replace(/\s/g, '')
  const password = typeof body.password === 'string' ? body.password : ''

  if (!email || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ message: MESSAGES.invalid, reason: 'invalid' })
  }
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ message: 'Password must be 8 to 128 characters.', reason: 'password' })
  }

  const resets = req.scope.resolve(PASSWORD_RESET_MODULE) as any
  const verdict = await resets.verifyCode(email, code)

  if (verdict !== 'ok') {
    return res.status(400).json({ message: MESSAGES[verdict] ?? MESSAGES.invalid, reason: verdict })
  }

  // Re-checked at the moment of change, not only when the code was sent.
  if (!(await isResettableCustomer(req.scope, email))) {
    await resets.consumeAll(email)
    return res.status(400).json({ message: MESSAGES.invalid, reason: 'invalid' })
  }

  const auth = req.scope.resolve(Modules.AUTH) as any
  const result = await auth.updateProvider('emailpass', { entity_id: email, password })

  if (!result?.success) {
    logger.error(`[password-reset] updateProvider failed for a customer: ${result?.error ?? 'unknown'}`)
    return res.status(500).json({ message: 'Could not change your password. Please try again.' })
  }

  await resets.consumeAll(email)

  // Security notice — best effort; the reset has already succeeded.
  await sendEmail(logger, { to: email, ...passwordChanged() })

  return res.status(200).json({ ok: true })
}
