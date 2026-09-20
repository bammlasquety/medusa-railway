import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, QueryContext } from '@medusajs/framework/utils'

/**
 * GET /store/coming-soon-products?region_id=&currency_code=&handle=&collection_id=
 *
 * Products in PROPOSED status, for the storefront's "Coming Soon" cards.
 *
 * Medusa's own /store/products only ever returns published products, so a
 * proposed one is invisible to the store without this. It is read-only and
 * returns the same public fields a published product exposes — nothing about a
 * proposed product is a secret once the merchant chose to tease it.
 *
 * Buying stays impossible: Medusa refuses to add unpublished products to a
 * cart, and the storefront renders no add-to-cart for these.
 *
 * Scoped to the sales channels of the caller's publishable key, the same rule
 * /store/products applies, so a product proposed for another channel stays
 * hidden.
 */
const FIELDS = [
  'id',
  'title',
  'subtitle',
  'description',
  'handle',
  'status',
  'thumbnail',
  'metadata',
  'collection_id',
  'images.*',
  'collection.id',
  'collection.handle',
  'collection.title',
  'sales_channels.id',
  'variants.id',
  'variants.title',
  'variants.sku',
  'variants.metadata',
  'variants.manage_inventory',
  'variants.allow_backorder',
  'variants.calculated_price.*',
]

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as any
  const q = req.query as Record<string, string | string[] | undefined>

  const one = (value: unknown) => (Array.isArray(value) ? value[0] : value)
  const handle = String(one(q.handle) ?? '').trim()
  const regionId = String(one(q.region_id) ?? '').trim()
  const currencyCode = String(one(q.currency_code) ?? '').trim().toLowerCase()
  const collectionIds = ([] as string[])
    .concat((q.collection_id as any) ?? [])
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean)

  const filters: Record<string, unknown> = { status: 'proposed' }
  if (handle) filters.handle = handle
  if (collectionIds.length) filters.collection_id = collectionIds

  const { data } = await query.graph({
    entity: 'product',
    fields: FIELDS,
    filters,
    pagination: { take: 50 },
    ...(regionId
      ? {
          context: {
            variants: {
              calculated_price: QueryContext({
                region_id: regionId,
                ...(currencyCode ? { currency_code: currencyCode } : {}),
              }),
            },
          },
        }
      : {}),
  })

  const allowed: string[] = (req as any).publishable_key_context?.sales_channel_ids ?? []

  const products = (data ?? []).filter((product: any) => {
    if (!allowed.length) return true
    return (product.sales_channels ?? []).some((channel: any) => allowed.includes(channel?.id))
  })

  res.json({ products: products.map(({ sales_channels, ...product }: any) => product) })
}
