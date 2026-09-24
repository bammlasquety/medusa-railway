import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'

/**
 * GET /store/checkout-preflight?cart_id=
 *
 * Answers one question: would `completeCartWorkflow` accept this cart?
 *
 * WHY THIS EXISTS
 * ---------------
 * Medusa requires every shipping profile represented by the cart's items to be
 * covered by a shipping method whose option belongs to that same profile. That
 * check runs INSIDE cart completion — which the storefront can only call after
 * the buyer has paid. So a profile mismatch stays invisible until money has
 * moved, and then the cart can never become an order: the buyer sits on
 * "Confirming your payment…" forever and the merchant holds a charge with no
 * order behind it.
 *
 * That is not hypothetical. On 2026-09-24 cart_01M38K2QTXTHEWW3RJJA0WHAEF was
 * charged and refused: the store had TWO shipping profiles of type "default"
 * (Medusa creates one; an earlier version of our seed script created another),
 * the calendar sat in one and the only priced delivery option in the other.
 * Everything looked correct in Admin.
 *
 * The store API cannot answer this on its own: /store/shipping-options does not
 * filter by profile, and a product's shipping_profile_id is not a store field.
 * Hence a route of our own — read-only, one cart at a time.
 *
 * Nothing here is secret: it reports which delivery profiles a cart needs and
 * whether they are covered, the same fact a checkout page shows as "delivery
 * unavailable".
 *
 * Three small queries rather than one deep one. `cart -> item -> product ->
 * shipping_profile` crosses two module links, and a single nested selection
 * that silently returns nothing would make a broken store look healthy — the
 * one failure mode this route must never have.
 */
type Profile = { id: string; name: string | null; items: string[] }

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const raw = Array.isArray(req.query.cart_id) ? req.query.cart_id[0] : req.query.cart_id
  const cartId = String(raw ?? '').trim()
  if (!cartId) return res.status(400).json({ message: 'cart_id is required' })

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY) as any

  const { data: carts } = await query.graph({
    entity: 'cart',
    filters: { id: cartId },
    fields: [
      'id',
      'completed_at',
      'items.id',
      'items.title',
      'items.product_id',
      'items.requires_shipping',
      'shipping_methods.id',
      'shipping_methods.shipping_option_id',
    ],
  })

  const cart = carts?.[0]
  if (!cart) return res.status(404).json({ message: 'Cart not found' })

  const items = (cart.items ?? []) as any[]
  const productIds = [...new Set(items.map((i) => i?.product_id).filter(Boolean))] as string[]
  const optionIds = [
    ...new Set(
      ((cart.shipping_methods ?? []) as any[]).map((m) => m?.shipping_option_id).filter(Boolean)
    ),
  ] as string[]

  const profileByProduct = new Map<string, { id: string; name: string | null }>()
  if (productIds.length) {
    const { data: products } = await query.graph({
      entity: 'product',
      filters: { id: productIds },
      fields: ['id', 'shipping_profile.id', 'shipping_profile.name'],
    })
    for (const product of products ?? []) {
      const profile = (product as any)?.shipping_profile
      if (profile?.id) profileByProduct.set(product.id, { id: profile.id, name: profile.name ?? null })
    }
  }

  const covered = new Set<string>()
  if (optionIds.length) {
    const { data: options } = await query.graph({
      entity: 'shipping_option',
      filters: { id: optionIds },
      fields: ['id', 'shipping_profile_id'],
    })
    for (const option of options ?? []) {
      const id = (option as any)?.shipping_profile_id
      if (id) covered.add(String(id))
    }
  }

  /**
   * Items whose product has no resolvable profile are NOT treated as a failure.
   * An unknown is not a mismatch, and this route only ever earns the right to
   * stop a sale on something it is certain of.
   */
  const required = new Map<string, Profile>()
  for (const item of items) {
    const profile = item?.product_id ? profileByProduct.get(item.product_id) : undefined
    if (!profile) continue
    const entry = required.get(profile.id) ?? { id: profile.id, name: profile.name, items: [] }
    entry.items.push(item.title ?? item.id)
    required.set(profile.id, entry)
  }

  const missing = [...required.values()].filter((profile) => !covered.has(profile.id))
  const unresolved = items
    .filter((item) => !item?.product_id || !profileByProduct.has(item.product_id))
    .map((item) => item?.title ?? item?.id)

  res.json({
    cart_id: cart.id,
    completed: Boolean(cart.completed_at),
    ok: missing.length === 0,
    required_profiles: [...required.values()].map((profile) => ({
      ...profile,
      covered: covered.has(profile.id),
    })),
    covered_profiles: [...covered],
    /** Populated only when ok is false — precisely why the cart would be refused. */
    missing_profiles: missing,
    /** Items whose profile could not be read; reported, never acted on. */
    unresolved_items: unresolved,
  })
}
