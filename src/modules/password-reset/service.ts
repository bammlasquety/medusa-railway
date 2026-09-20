import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { MedusaService } from '@medusajs/framework/utils'

import { PasswordResetCode } from './models/password-reset-code'

/** How long a PIN works. */
export const CODE_TTL_MINUTES = 10
/** Wrong guesses allowed on one PIN before it is burnt. 5 in 10^6 is a 0.0005% guess rate. */
export const MAX_ATTEMPTS = 5
/** Minimum gap between PIN emails to one address. */
export const RESEND_COOLDOWN_SECONDS = 60

export type VerifyResult = 'ok' | 'invalid' | 'expired' | 'locked'

function pepper(): string {
  const key = String(process.env.JWT_SECRET ?? '')
  if (key.length < 16) {
    throw new Error('[password-reset] JWT_SECRET is required to hash reset codes.')
  }
  return key
}

const hashCode = (email: string, code: string) =>
  createHmac('sha256', pepper()).update(`password-reset:${email}:${code}`).digest('hex')

class PasswordResetModuleService extends MedusaService({ PasswordResetCode }) {
  private async latestActive(email: string) {
    const [row] = await this.listPasswordResetCodes(
      { email, consumed_at: null },
      { order: { created_at: 'DESC' }, take: 1 }
    )
    return row ?? null
  }

  /**
   * Issues a new PIN and burns any earlier ones, so only the most recent email
   * works. Returns null (and sends nothing) inside the cooldown window — the
   * caller answers the same either way, so this cannot be used to probe.
   */
  async issueCode(email: string, ip: string | null): Promise<{ code: string; expiresAt: Date } | null> {
    const previous = await this.latestActive(email)

    if (previous) {
      const ageSeconds = (Date.now() - new Date(previous.created_at as any).getTime()) / 1000
      if (ageSeconds < RESEND_COOLDOWN_SECONDS) return null
    }

    await this.consumeAll(email)

    // randomInt is CSPRNG-backed and uniform; padStart keeps leading zeros.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000)

    await this.createPasswordResetCodes({
      email,
      code_hash: hashCode(email, code),
      expires_at: expiresAt,
      requested_ip: ip,
    })

    return { code, expiresAt }
  }

  /** Checks a PIN. Every wrong guess counts; the fifth burns the PIN. */
  async verifyCode(email: string, code: string): Promise<VerifyResult> {
    const row = await this.latestActive(email)
    if (!row) return 'invalid'

    if (new Date(row.expires_at as any).getTime() <= Date.now()) {
      await this.updatePasswordResetCodes({ id: row.id, consumed_at: new Date() })
      return 'expired'
    }

    if (Number(row.attempts) >= MAX_ATTEMPTS) return 'locked'

    const expected = Buffer.from(String(row.code_hash), 'hex')
    const presented = Buffer.from(hashCode(email, code), 'hex')
    const match = expected.length === presented.length && timingSafeEqual(expected, presented)

    if (!match) {
      const attempts = Number(row.attempts) + 1
      await this.updatePasswordResetCodes({
        id: row.id,
        attempts,
        ...(attempts >= MAX_ATTEMPTS ? { consumed_at: new Date() } : {}),
      })
      return attempts >= MAX_ATTEMPTS ? 'locked' : 'invalid'
    }

    return 'ok'
  }

  /** Single use: after a successful reset every outstanding PIN for the email dies. */
  async consumeAll(email: string): Promise<void> {
    const open = await this.listPasswordResetCodes({ email, consumed_at: null }, { select: ['id'] })
    if (!open.length) return
    await this.updatePasswordResetCodes(open.map((row) => ({ id: row.id, consumed_at: new Date() })))
  }
}

export default PasswordResetModuleService
