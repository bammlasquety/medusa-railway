import type { IProductModuleService } from '@medusajs/framework/types'

import type { AssetCatalogue, CatalogueLine, DigitalAsset } from '../ports'

/**
 * Reads the digital contract out of Medusa product and variant metadata.
 *
 * Chosen over a linked data model because it is editable in Medusa admin today
 * with no custom widget to build. Its weakness is that metadata is
 * stringly-typed and unvalidated — see ADR 0001, Consequences.
 *
 *   digital       "true"                          required
 *   file_path     "agarwood/90-day-guide.pdf"     required — key inside the bucket
 *   file_bucket   "digital-products"              optional
 *   file_name     "Agarwood 90-Day Guide.pdf"     optional
 *   content_type  "application/pdf"               optional
 *   max_downloads "5"                             optional
 *   access_days   "30"                            optional
 *
 * Variant metadata wins over product metadata key by key, so one product can
 * sell PDF and EPUB editions as separate variants.
 */

const DEFAULT_BUCKET = 'digital-products'
const DEFAULT_MAX_DOWNLOADS = 5
const DEFAULT_ACCESS_DAYS = 30

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  m4b: 'audio/mp4',
}

type Meta = Record<string, unknown> | null | undefined

/** Admin writes strings; the JS API and seed scripts write booleans. Accepting
 *  both stops a working product becoming undeliverable because of where it was
 *  edited. */
function isTruthy(value: unknown): boolean {
  if (value === true) return true
  return ['true', '1', 'yes', 'y'].includes(String(value ?? '').trim().toLowerCase())
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function inferContentType(path: string): string {
  return CONTENT_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

/**
 * Normalises a storage key. Leading slashes and `..` segments are stripped:
 * this value comes from a text box in an admin UI, and a path that can climb out
 * of its prefix is a traversal waiting for one typo.
 */
function safeStoragePath(raw: string): string {
  return raw
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
}

export class MetadataAssetCatalogue implements AssetCatalogue {
  constructor(
    private readonly productService: IProductModuleService,
    private readonly logger: { warn(msg: string): void }
  ) {}

  async resolve(lines: CatalogueLine[]): Promise<DigitalAsset[]> {
    const productIds = [...new Set(lines.map((l) => String(l.product_id ?? '')).filter(Boolean))]
    if (!productIds.length) return []

    // One catalogue round trip for the whole order. A basket of eight ebooks
    // should not be eight sequential lookups inside a workflow step.
    const products = await this.productService.listProducts(
      { id: productIds },
      { relations: ['variants'], take: productIds.length }
    )

    const byProduct = new Map<string, any>()
    const byVariant = new Map<string, any>()

    for (const product of products) {
      byProduct.set(String(product.id), product)
      for (const variant of product.variants ?? []) byVariant.set(String(variant.id), variant)
    }

    const assets: DigitalAsset[] = []

    for (const line of lines) {
      const asset = this.toAsset(
        line,
        byProduct.get(String(line.product_id ?? ''))?.metadata,
        byVariant.get(String(line.variant_id ?? ''))?.metadata
      )
      if (asset) assets.push(asset)
    }

    return assets
  }

  /**
   * Returns null when the line is not digital.
   *
   * A line flagged digital with no `file_path` is a merchandising mistake that
   * is otherwise invisible — the buyer simply never gets a link. It is logged
   * and skipped rather than thrown, so one bad product does not stop the rest of
   * a mixed basket being delivered.
   */
  private toAsset(line: CatalogueLine, productMeta: Meta, variantMeta: Meta): DigitalAsset | null {
    const meta: Record<string, unknown> = { ...(productMeta ?? {}), ...(variantMeta ?? {}) }
    if (!isTruthy(meta.digital)) return null

    const path = safeStoragePath(str(meta.file_path))
    const lineItemId = String(line.id ?? '')
    const variantId = String(line.variant_id ?? '')

    if (!path || !variantId || !lineItemId) {
      this.logger.warn(
        `[digital-delivery] line ${lineItemId || '?'} (variant ${variantId || '?'}) is flagged ` +
          `digital but is not deliverable: ${path ? 'missing ids' : 'missing file_path'}`
      )
      return null
    }

    const productTitle = str(line.product_title) || str(line.title) || 'Your download'
    const variantTitle = str(line.variant_title)

    return {
      lineItemId,
      variantId,
      productId: String(line.product_id ?? ''),
      title:
        variantTitle && variantTitle !== productTitle
          ? `${productTitle} — ${variantTitle}`
          : productTitle,
      bucket: str(meta.file_bucket) || DEFAULT_BUCKET,
      path,
      fileName: str(meta.file_name) || path.split('/').pop() || 'download',
      contentType: str(meta.content_type) || inferContentType(path),
      maxDownloads: positiveInt(meta.max_downloads, DEFAULT_MAX_DOWNLOADS),
      accessDays: positiveInt(meta.access_days, DEFAULT_ACCESS_DAYS),
    }
  }
}
