/**
 * The two things that will change, expressed as interfaces so that changing them
 * is an addition rather than a rewrite.
 *
 * Everything downstream — the workflow, the API routes, the service — depends on
 * these types and never on Supabase or on Medusa's product metadata. That is the
 * whole of the dependency inversion here, and it is the reason the storage
 * decision in ADR 0001 is reversible.
 */

export interface DigitalAsset {
  lineItemId: string
  variantId: string
  productId: string
  title: string
  bucket: string
  path: string
  fileName: string
  contentType: string
  maxDownloads: number
  accessDays: number
}

/** An order line as much of it as this module needs. Deliberately structural:
 *  it is satisfied by Medusa's order items, cart items and fulfillment items
 *  alike, so the catalogue can be exercised from a test without an order. */
export interface CatalogueLine {
  id?: string | null
  variant_id?: string | null
  product_id?: string | null
  product_title?: string | null
  variant_title?: string | null
  title?: string | null
}

/**
 * Answers "which of these lines are digital, and what file is each one?"
 *
 * Implemented today by MetadataAssetCatalogue (product metadata). The intended
 * successor is a linked DigitalProduct data model with an admin widget — see
 * ADR 0001, Alternatives.
 */
export interface AssetCatalogue {
  resolve(lines: CatalogueLine[]): Promise<DigitalAsset[]>
}

/**
 * Turns storage coordinates into a URL a browser can follow, for a short time.
 *
 * `ttlSeconds` is intentionally a parameter and not a constant: the caller knows
 * whether the URL is about to be followed by a redirect (seconds) or handed to a
 * human (it never is — see ADR 0001).
 */
export interface SignedUrlIssuer {
  issue(input: {
    bucket: string
    path: string
    ttlSeconds: number
    downloadAs?: string
  }): Promise<string>
}

/** Emitted once per order after grants exist. The email subscriber listens for
 *  this rather than for `order.placed`, so an order with no digital lines never
 *  produces an email with nothing in it. */
export const DIGITAL_DELIVERY_GRANTED = 'digital_delivery.granted'

export interface DigitalDeliveryGrantedPayload {
  order_id: string
  grant_ids: string[]
}
