/**
 * Sends one transactional email straight through Resend's API.
 *
 * Used for password-reset PINs instead of the Notification Module on purpose:
 * Medusa persists every notification's `data` in its own table, which would put
 * a working reset code at rest in plain text. This path stores nothing.
 */
export async function sendEmail(
  logger: { error(m: string): void },
  message: { to: string; subject: string; html: string; text: string }
): Promise<boolean> {
  const apiKey = String(process.env.RESEND_API_KEY ?? '')
  const from = String(process.env.RESEND_FROM ?? '')

  if (!apiKey || !from) {
    logger.error('[email] RESEND_API_KEY / RESEND_FROM not set; cannot send email')
    return false
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      logger.error(`[email] Resend rejected "${message.subject}" (${response.status})`)
      return false
    }
    return true
  } catch (error) {
    logger.error(`[email] Resend request failed: ${(error as Error)?.message ?? error}`)
    return false
  }
}
