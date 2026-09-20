/**
 * Password-reset emails: the PIN, and the "your password was changed" notice.
 * Same table layout and palette as digital-downloads-ready.ts.
 */

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#FAF8F4;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F4;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#FFFFFF;border:1px solid #E5DCCB;border-radius:24px;">
        <tr><td style="padding:32px 28px;">${body}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`

const p = (text: string, size = 15) =>
  `<p style="margin:16px 0 0;font:400 ${size}px/1.6 Helvetica,Arial,sans-serif;color:#65605A;">${text}</p>`

export function passwordResetCode(data: { code: string; minutes: number }) {
  const code = String(data.code).replace(/\D/g, '').slice(0, 6)
  const subject = `${code} is your Dendrotonics Store password reset code`

  const html = shell(
    'Password reset code',
    `<h1 style="margin:0;font:600 26px/1.2 Georgia,serif;color:#1C2620;">Reset your password</h1>
     <div style="height:1px;width:72px;margin:18px 0;background:#C2A14D;"></div>
     ${p('Enter this code on the Dendrotonics Store to choose a new password:')}
     <div style="margin:20px 0 4px;padding:18px 0;border-radius:16px;background:#F3EEE4;text-align:center;
                 font:600 34px/1 'Courier New',monospace;letter-spacing:10px;color:#1C2620;">${code}</div>
     ${p(`It expires in <strong style="color:#1C2620;">${data.minutes} minutes</strong> and works once.`, 14)}
     ${p('Didn’t ask for this? Ignore this email — your password stays the same. Never share this code; we will never ask you for it.', 13)}`
  )

  const text = [
    'Reset your password',
    '',
    `Your code: ${code}`,
    `It expires in ${data.minutes} minutes and works once.`,
    '',
    "Didn't ask for this? Ignore this email — your password stays the same.",
    'Never share this code; we will never ask you for it.',
  ].join('\n')

  return { subject, html, text }
}

export function passwordChanged() {
  const subject = 'Your Dendrotonics Store password was changed'
  const html = shell(
    'Password changed',
    `<h1 style="margin:0;font:600 26px/1.2 Georgia,serif;color:#1C2620;">Password changed</h1>
     <div style="height:1px;width:72px;margin:18px 0;background:#C2A14D;"></div>
     ${p('The password for your Dendrotonics Store account was just changed using a code sent to this email.')}
     ${p('If this wasn’t you, reset your password again right away and contact us at info@dendrotonics.com.', 13)}`
  )
  const text = [
    'Password changed',
    '',
    'The password for your Dendrotonics Store account was just changed using a code sent to this email.',
    "If this wasn't you, reset your password again right away and contact us at info@dendrotonics.com.",
  ].join('\n')
  return { subject, html, text }
}
