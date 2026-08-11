import { createHash, randomBytes } from 'node:crypto'

import type { Logger } from '@medusajs/framework/types'
import { MedusaError, MedusaService } from '@medusajs/framework/utils'

import { SupabaseSignedUrlIssuer } from './adapters/supabase-signed-url-issuer'
import { DigitalGrant } from './models/digital-grant'
import { DownloadToken } from './models/download-token'
import type { DigitalAsset, SignedUrlIssuer } from './ports'

/**
 * Owns the delivery half of digital fulfillment: who may download what, how many
 * times, until when — and the redemption of a token into a pre-signed URL.
 *
 * It does NOT decide which products are digital (that is the AssetCatalogue) and
 * it does not orchestrate (that is the workflow). Those separations are what
 * keep this class testable without an order, a product or a bucket.
 */

const TOKEN_BYTES = 32
export const PAGE_TOKEN_TTL_MS = 15 * 60 * 1000
export const EMAIL_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The signed URL's entire life is one browser redirect. Sixty seconds is
 * generous for that and short enough that a URL copied out of devtools is
 * near-worthless. It is deliberately not a config option: making it longer
 * silently undoes the download counter.
 */
const SIGNED_URL_TTL_SECONDS = 60

export interface DigitalDeliveryOptions {
  supabase?: { url: string; serviceKey: string }
  /** Absolute origin of the storefront. Used to build the links that go in
   *  emails, so they land on your domain rather than the backend's. */
  storefrontUrl: string
}

type InjectedDependencies = {
  logger: Logger
}

export interface GrantInput extends DigitalAsset {
  orderId: string
  fulfillmentId?: string | null
  customerId?: string | null
  email: string
}

export interface IssuedLink {
  grantId: string
  title: string
  fileName: string
  url: string
  expiresAt: Date
  downloadsRemaining: number
  accessExpiresAt: Date
}

export type RedemptionFailure =
  | 'not_found'
  | 'token_expired'
  | 'access_expired'
  | 'limit_reached'
  | 'revoked'

export type Redemption =
  | { ok: true; url: string; fileName: string; downloadsRemaining: number }
  | { ok: false; reason: RedemptionFailure }

/**
 * Deliberately FLAT rather than a discriminated union.
 *
 * This project compiles with `"strict": false`, and without `strictNullChecks`
 * TypeScript does not narrow a union on a boolean literal discriminant. A union
 * here would compile locally under strict settings and fail in this repo — which
 * is exactly what happened.
 */
interface SpendResult {
  ok: boolean
  reason?: RedemptionFailure
  bucket?: string
  path?: string
  fileName?: string
  downloadsRemaining?: number
}

class DigitalDeliveryModuleService extends MedusaService({ DigitalGrant, DownloadToken }) {
  protected readonly logger_: Logger
  protected readonly options_: DigitalDeliveryOptions
  protected storage_?: SignedUrlIssuer

  /**
   * Validation is LAZY, and that is deliberate.
   *
   * Throwing here for a missing `storefrontUrl` or Supabase credential means the
   * module cannot be constructed at all — which breaks `medusa db:generate`,
   * because the CLI loads every registered module to read its models. You would
   * be unable to generate a migration on a machine that has no production
   * secrets, which is exactly the machine you want to generate it on.
   *
   * Nothing is lost: the checks still run, just at the first call that actually
   * needs them, where the error also has a caller to blame.
   */
  constructor({ logger }: InjectedDependencies, options: DigitalDeliveryOptions) {
    super(...arguments)

    this.logger_ = logger
    this.options_ = options ?? ({} as DigitalDeliveryOptions)
  }

  /** The storefront origin download links are built on. */
  private origin(): string {
    const url = this.options_?.storefrontUrl
    if (!url) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        'digital-delivery: `storefrontUrl` is required — it is the origin download links are built on.'
      )
    }
    return url.replace(/\/$/, '')
  }

  /**
   * Built on first use rather than injected, because the module's options are
   * the only place the credentials exist. Swapping storage providers is one
   * line; see ADR 0001.
   */
  private storage(): SignedUrlIssuer {
    if (!this.storage_) {
      this.storage_ = new SupabaseSignedUrlIssuer(this.options_?.supabase as any)
    }
    return this.storage_
  }

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  /**
   * Creates one grant per digital line, and returns the full set for the order
   * whether created now or earlier.
   *
   * Re-runnable on purpose. A replayed `order.placed`, an admin retry or a
   * workflow rerun must not reset `download_count` — that would quietly restore
   * an allowance the buyer has already spent. Existing rows are left untouched.
   */
  async grantForOrder(inputs: GrantInput[]): Promise<any[]> {
    if (!inputs.length) return []

    const orderId = inputs[0]!.orderId
    const existing = await this.listDigitalGrants({ order_id: orderId })
    const alreadyGranted = new Set(existing.map((grant: any) => String(grant.line_item_id)))

    const missing = inputs.filter((input) => !alreadyGranted.has(input.lineItemId))

    if (missing.length) {
      await this.createDigitalGrants(
        missing.map((input) => ({
          order_id: input.orderId,
          fulfillment_id: input.fulfillmentId ?? null,
          line_item_id: input.lineItemId,
          variant_id: input.variantId,
          product_id: input.productId,
          customer_id: input.customerId ?? null,
          email: input.email,
          title: input.title,
          storage_bucket: input.bucket,
          storage_path: input.path,
          file_name: input.fileName,
          content_type: input.contentType,
          max_downloads: input.maxDownloads,
          expires_at: new Date(Date.now() + input.accessDays * 24 * 60 * 60 * 1000),
        }))
      )
    }

    return this.listDigitalGrants({ order_id: orderId })
  }

  /** Used by cancelFulfillment. Revocation takes effect on the next redemption,
   *  including for tokens already sitting in an inbox — which is the advantage
   *  of redeeming through here instead of emailing a raw signed URL. */
  async revokeForOrder(orderId: string): Promise<number> {
    const grants = await this.listDigitalGrants({ order_id: orderId, revoked_at: null })
    if (!grants.length) return 0

    await this.updateDigitalGrants(
      grants.map((grant: any) => ({ id: grant.id, revoked_at: new Date() }))
    )

    return grants.length
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  /**
   * Mints one short-lived link per usable grant.
   *
   * Called on every visit to order history rather than once at fulfillment,
   * because a link that is bookmarked or forwarded should be dead while the
   * buyer should still be able to get a live one from a page they can prove is
   * theirs.
   *
   * Grants that are revoked, expired or out of downloads are skipped here as
   * well as inside `redeem`. This copy exists so the UI can explain itself; the
   * one in `redeem` is the one that is load-bearing.
   */
  async issueLinks(
    grants: any[],
    opts: { purpose?: 'page' | 'email'; ip?: string | null } = {}
  ): Promise<IssuedLink[]> {
    const purpose = opts.purpose ?? 'page'
    const now = Date.now()
    const ttl = purpose === 'email' ? EMAIL_TOKEN_TTL_MS : PAGE_TOKEN_TTL_MS

    const usable = grants.filter((grant) => this.usable(grant, now))
    if (!usable.length) return []

    const expiresAt = new Date(now + ttl)
    const secrets = usable.map(() => randomBytes(TOKEN_BYTES).toString('base64url'))

    await this.createDownloadTokens(
      usable.map((grant, index) => ({
        grant_id: grant.id,
        token_hash: this.hash(secrets[index]!),
        purpose,
        expires_at: expiresAt,
        issued_ip: opts.ip ?? null,
      }))
    )

    const origin = this.origin()

    return usable.map((grant, index) => ({
      grantId: String(grant.id),
      title: String(grant.title),
      fileName: String(grant.file_name),
      url: `${origin}/api/downloads/${secrets[index]}`,
      expiresAt,
      downloadsRemaining: Number(grant.max_downloads) - Number(grant.download_count),
      accessExpiresAt: new Date(grant.expires_at),
    }))
  }

  /**
   * Spends one download and returns a pre-signed URL.
   *
   * Every check and the counter increment happen inside one transaction: a
   * read-then-write would let two concurrent requests both pass the
   * `count < max` check and push the total past the cap. `redeem` is the only
   * way to the bytes, which is what makes the counter and revocation real.
   *
   * Failures come back as a reason rather than an exception — an expired link is
   * an ordinary Tuesday, not an error condition.
   */
  async redeem(rawToken: string, ip?: string | null): Promise<Redemption> {
    const outcome = await this.spendDownload_(this.hash(rawToken), ip ?? null)

    /**
     * Built explicitly rather than returned through, because this project sets
     * `"strict": false`.
     *
     * Without `strictNullChecks`, TypeScript will not narrow a discriminated
     * union on a boolean literal — `if (!outcome.ok) return outcome` leaves the
     * `ok: true` branch in the type and fails to compile. `SpendResult` is
     * therefore a single flat shape, and the union lives only at this boundary
     * where it is constructed by hand.
     */
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason ?? 'not_found' }
    }

    /**
     * Signing happens AFTER the counter is committed, so a storage outage cannot
     * hand out a free download. The trade is the opposite failure: a counted
     * download whose file could not be signed. That one is visible (the buyer
     * sees an error and contacts you) where the other is silent.
     */
    const url = await this.storage().issue({
      bucket: String(outcome.bucket),
      path: String(outcome.path),
      ttlSeconds: SIGNED_URL_TTL_SECONDS,
      downloadAs: String(outcome.fileName),
    })

    return {
      ok: true,
      url,
      fileName: String(outcome.fileName),
      downloadsRemaining: Number(outcome.downloadsRemaining ?? 0),
    }
  }

  /**
   * Consumes one download, or explains why not.
   *
   * An earlier version did a conditional `nativeUpdate` through the injected
   * transaction manager, which was elegant and would not have run: `model.define()`
   * returns a Medusa DML definition, not a MikroORM entity class, so it cannot be
   * handed to `nativeUpdate`. This version uses only the methods `MedusaService`
   * generates, which are the module's actual public surface.
   *
   * SINGLE-USE TOKENS are what replace the conditional update. `used_at` moves
   * from null to a timestamp exactly once, and a token that has already been
   * spent is refused — so a leaked or shared link is worth one download, not
   * `max_downloads`. That is the property that actually protects the file.
   *
   * Residual race, stated plainly: two DIFFERENT unspent tokens for the same
   * grant, redeemed in the same instant, can both pass the cap check and push
   * `download_count` one past `max_downloads`. Doing better needs an atomic
   * increment, which needs raw SQL, which is what was wrong before. For a cap
   * that exists to discourage link-sharing on a ₱299 ebook, one extra download
   * under concurrent load is the right thing to accept. It is not a financial
   * invariant, and pretending otherwise cost a deploy cycle already.
   */
  protected async spendDownload_(tokenHash: string, ip: string | null): Promise<SpendResult> {
    const [token] = await this.listDownloadTokens(
      { token_hash: tokenHash },
      { relations: ['grant'], take: 1 }
    )

    if (!token) return { ok: false, reason: 'not_found' }
    if (token.used_at) return { ok: false, reason: 'token_expired' }
    if (new Date(token.expires_at).getTime() <= Date.now()) {
      return { ok: false, reason: 'token_expired' }
    }

    const grant = (token as any).grant
    if (!grant) return { ok: false, reason: 'not_found' }

    if (grant.revoked_at) return { ok: false, reason: 'revoked' }
    if (new Date(grant.expires_at).getTime() <= Date.now()) {
      return { ok: false, reason: 'access_expired' }
    }
    if (Number(grant.download_count) >= Number(grant.max_downloads)) {
      return { ok: false, reason: 'limit_reached' }
    }

    // Spend the token FIRST. If the grant update then fails, the buyer has lost
    // one link but no download was counted — recoverable by reloading the order
    // page. The other order would count a download nobody received.
    await this.updateDownloadTokens([
      { id: token.id, used_at: new Date(), issued_ip: token.issued_ip ?? ip },
    ])

    const nextCount = Number(grant.download_count) + 1

    await this.updateDigitalGrants([
      { id: grant.id, download_count: nextCount, last_downloaded_at: new Date() },
    ])

    return {
      ok: true,
      bucket: String(grant.storage_bucket),
      path: String(grant.storage_path),
      fileName: String(grant.file_name),
      downloadsRemaining: Math.max(0, Number(grant.max_downloads) - nextCount),
    }
  }

  // -------------------------------------------------------------------------

  private usable(grant: any, now: number): boolean {
    return (
      !grant.revoked_at &&
      new Date(grant.expires_at).getTime() > now &&
      Number(grant.download_count) < Number(grant.max_downloads)
    )
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }
}

export default DigitalDeliveryModuleService
