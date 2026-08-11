/**
 * The delivery email.
 *
 * Table-based layout and inline styles, because Outlook still does not support
 * flexbox or grid and this is the one email in the system a customer is
 * guaranteed to open. The palette matches the storefront's light theme tokens so
 * the email does not look like it came from somewhere else.
 *
 * A plain-text alternative is not optional here: some clients strip HTML
 * entirely, and a download email that arrives blank is indistinguishable from
 * not arriving.
 */

interface Item {
  title: string
  file_name: string
  url: string
  downloads_remaining: number
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatDate(value: unknown): string {
  const date = new Date(String(value ?? ''))
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function digitalDownloadsReady(data: Record<string, any>) {
  const items: Item[] = Array.isArray(data.items) ? data.items : []
  const orderRef = data.order_display_id ? `#${data.order_display_id}` : ''
  const accessUntil = formatDate(data.access_expires_at)
  const linkUntil = formatDate(data.expires_at)

  const subject = items.length === 1
    ? `Your download is ready${orderRef ? ` — order ${orderRef}` : ''}`
    : `Your ${items.length} downloads are ready${orderRef ? ` — order ${orderRef}` : ''}`

  const rows = items
    .map(
      (item) => `
      <tr>
        <td style="padding:16px 0;border-bottom:1px solid #E5DCCB;">
          <div style="font:600 16px/1.4 Georgia,serif;color:#1C2620;">${escapeHtml(item.title)}</div>
          <div style="font:400 13px/1.5 Helvetica,Arial,sans-serif;color:#65605A;margin-top:2px;">
            ${escapeHtml(item.file_name)} &middot; ${Number(item.downloads_remaining)} download${
              Number(item.downloads_remaining) === 1 ? '' : 's'
            } remaining
          </div>
          <a href="${escapeHtml(item.url)}"
             style="display:inline-block;margin-top:12px;padding:11px 22px;border-radius:14px;
                    background:#2F5D46;color:#FFFFFF;text-decoration:none;
                    font:500 14px/1 Helvetica,Arial,sans-serif;">Download</a>
        </td>
      </tr>`
    )
    .join('')

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#FAF8F4;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F4;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#FFFFFF;border:1px solid #E5DCCB;border-radius:24px;">
        <tr><td style="padding:32px 28px;">

          <h1 style="margin:0;font:600 26px/1.2 Georgia,serif;color:#1C2620;">Thank you</h1>
          <div style="height:1px;width:72px;margin:18px 0;background:#C2A14D;"></div>

          <p style="margin:0;font:400 15px/1.6 Helvetica,Arial,sans-serif;color:#65605A;">
            Your ${items.length === 1 ? 'file is' : 'files are'} ready${
              orderRef ? ` for order <strong style="color:#1C2620;">${escapeHtml(orderRef)}</strong>` : ''
            }.
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="margin-top:8px;">${rows}</table>

          <p style="margin:24px 0 0;font:400 13px/1.6 Helvetica,Arial,sans-serif;color:#65605A;">
            ${linkUntil ? `These links stop working on ${escapeHtml(linkUntil)}. ` : ''}
            ${accessUntil ? `You can re-download from your order history until ${escapeHtml(accessUntil)}.` : ''}
          </p>

          <p style="margin:16px 0 0;font:400 12px/1.6 Helvetica,Arial,sans-serif;color:#65605A;">
            These links are personal to you. Anyone you forward them to can use up your downloads.
          </p>

        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`

  const text = [
    subject,
    '',
    ...items.flatMap((item) => [
      item.title,
      `${item.file_name} — ${item.downloads_remaining} download(s) remaining`,
      item.url,
      '',
    ]),
    linkUntil ? `These links stop working on ${linkUntil}.` : '',
    accessUntil ? `You can re-download from your order history until ${accessUntil}.` : '',
    '',
    'These links are personal to you. Anyone you forward them to can use up your downloads.',
  ]
    .filter(Boolean)
    .join('\n')

  return { subject, html, text }
}
