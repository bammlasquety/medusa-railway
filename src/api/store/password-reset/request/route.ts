import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'

import { isTrustedStorefront, storefrontClientIp } from '../../../../lib/storefront-guard'
import { sendEmail } from '../../../../lib/send-email'
import { logCommerceIssue } from '../../../../lib/commerce-issues'
import { PASSWORD_RESET_MODULE } from '../../../../modules/password-reset'
import { CODE_TTL_MINUTES } from '../../../../modules/password-reset/service'
import { passwordResetCode } from '../../../../modules/resend/templates/password-reset'
import { isResettableCustomer, normaliseEmail } from '../_eligibility'

/**
 * POST /store/password-reset/request  { email }
 *
 * ALWAYS answers `{ ok: true }` — for unknown emails, admin emails, the resend
 * cooldown and success alike — so this cannot be used to discover which
 * emails have accounts. Only the storefront server may call it.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  if (!isTrustedStorefront(req)) return res.status(403).json({ message: 'Forbidden' })

  const logger = req.scope.resolve('logger') as any
  const email = normaliseEmail((req.body as any)?.email)
  const generic = { ok: true }

  if (!email) return res.status(200).json(generic)

  try {
    if (!(await isResettableCustomer(req.scope, email))) return res.status(200).json(generic)

    const resets = req.scope.resolve(PASSWORD_RESET_MODULE) as any
    const issued = await resets.issueCode(email, storefrontClientIp(req))
    if (!issued) return res.status(200).json(generic) // cooldown: the earlier code still works

    const sent = await sendEmail(logger, { to: email, ...passwordResetCode({ code: issued.code, minutes: CODE_TTL_MINUTES }) })
    if (!sent) {
      await logCommerceIssue(logger, {
        stage: 'other',
        code: 'account.reset_email_failed',
        severity: 'error',
        message: 'A password reset code could not be emailed (Resend). The customer cannot reset their password.',
        email,
      })
    }
  } catch (error) {
    logger.error(`[password-reset] request failed: ${(error as Error)?.message ?? error}`)
  }

  return res.status(200).json(generic)
}
