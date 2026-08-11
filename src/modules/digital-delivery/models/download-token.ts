import { model } from '@medusajs/framework/utils'

import { DigitalGrant } from './digital-grant'

/**
 * Permission to fetch a granted file within the next few minutes (order history)
 * or days (email).
 *
 * Only the SHA-256 hash is stored. The raw token exists in exactly one HTTP
 * response and in the buyer's address bar — never at rest. A database dump is
 * therefore not a set of working download links.
 *
 * SINGLE USE. `used_at` moves from null to a timestamp exactly once, and a spent
 * token is refused. This is deliberate and it is a reversal: the first design
 * allowed reuse within the TTL, on the grounds that browser prefetch and
 * interrupted downloads would burn tokens and generate support load. That
 * reasoning was sound, but it depended on an atomic counter increment to enforce
 * the download cap — and that needs raw SQL against entities this module does not
 * own. Single use is now the mechanism carrying the security weight: a forwarded
 * link is worth one download, not the whole allowance.
 *
 * The cost is real. A cancelled or retried download spends the token AND a
 * download from the cap. The mitigation is that the order page mints fresh links
 * on every load, so a burnt token is a reload, not a support ticket.
 *
 * `purpose` drives no decision; it is there so that when a link leaks, the audit
 * trail can say whether it came from a page or an inbox.
 */
export const DownloadToken = model
  .define('digital_download_token', {
    id: model.id({ prefix: 'dtok' }).primaryKey(),

    token_hash: model.text().unique(),
    purpose: model.enum(['page', 'email']).default('page'),
    expires_at: model.dateTime(),
    used_at: model.dateTime().nullable(),
    issued_ip: model.text().nullable(),

    grant: model.belongsTo(() => DigitalGrant, { mappedBy: 'tokens' }),
  })
  .indexes([{ on: ['expires_at'] }])
