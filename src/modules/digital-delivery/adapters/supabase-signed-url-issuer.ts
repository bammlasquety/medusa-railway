import { MedusaError } from '@medusajs/framework/utils'

import type { SignedUrlIssuer } from '../ports'

export interface SupabaseStorageOptions {
  url: string
  serviceKey: string
  /** Bounds the signing call itself, not the download. A storage API that hangs
   *  must not hang the redirect the buyer is waiting on. */
  timeoutMs?: number
}

/**
 * Issues Supabase Storage pre-signed URLs for objects in a private bucket.
 *
 * This is the only file in the module that knows Supabase exists. Replacing it
 * with an S3 or R2 issuer is a constructor change in medusa-config — see
 * ADR 0001.
 */
export class SupabaseSignedUrlIssuer implements SignedUrlIssuer {
  private readonly url: string
  private readonly key: string
  private readonly timeoutMs: number

  constructor(options: SupabaseStorageOptions) {
    if (!options?.url || !options?.serviceKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        'digital-delivery: Supabase storage requires `url` and `serviceKey`.'
      )
    }

    this.url = options.url.replace(/\/$/, '')
    this.key = options.serviceKey
    this.timeoutMs = options.timeoutMs ?? 8000
  }

  /**
   * Supabase has two key generations and they need different headers. Legacy
   * `service_role` keys are JWTs and belong in `Authorization: Bearer`; the
   * newer `sb_secret_…` keys are not JWTs and are rejected if sent that way, so
   * the Bearer header is only added when the key actually is one.
   */
  private headers(): Record<string, string> {
    return {
      apikey: this.key,
      ...(this.key.startsWith('eyJ') ? { Authorization: `Bearer ${this.key}` } : {}),
      'Content-Type': 'application/json',
    }
  }

  async issue({
    bucket,
    path,
    ttlSeconds,
    downloadAs,
  }: {
    bucket: string
    path: string
    ttlSeconds: number
    downloadAs?: string
  }): Promise<string> {
    // Each segment encoded separately: folders in a storage key are real slashes
    // and must survive, but a filename containing a space or "#" must not.
    const encodedPath = path
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent)
      .join('/')

    const response = await fetch(
      `${this.url}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodedPath}`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ expiresIn: ttlSeconds }),
        signal: AbortSignal.timeout(this.timeoutMs),
      }
    )

    if (!response.ok) {
      // The path is not a secret — the key is — so it is safe to name here and
      // it is the only thing that makes a missing object diagnosable.
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `digital-delivery: could not sign ${bucket}/${path} (${response.status}).`
      )
    }

    const body = (await response.json()) as { signedURL?: string; signedUrl?: string }
    const signed = body.signedURL ?? body.signedUrl

    if (!signed) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `digital-delivery: storage returned no signed URL for ${bucket}/${path}.`
      )
    }

    // Supabase returns a path relative to /storage/v1.
    const absolute = new URL(
      signed.startsWith('/') ? `${this.url}/storage/v1${signed}` : `${this.url}/storage/v1/${signed}`
    )

    // Makes the browser save rather than render, with the merchandising filename
    // instead of the storage key.
    if (downloadAs) absolute.searchParams.set('download', downloadAs)

    return absolute.toString()
  }
}
