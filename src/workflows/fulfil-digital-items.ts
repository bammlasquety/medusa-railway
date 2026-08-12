import { Modules } from '@medusajs/framework/utils'
import { createOrderFulfillmentWorkflow } from '@medusajs/medusa/core-flows'
import {
  StepResponse,
  WorkflowResponse,
  createStep,
  createWorkflow,
  transform,
} from '@medusajs/framework/workflows-sdk'

import { DIGITAL_DELIVERY_MODULE } from '../modules/digital-delivery'
import { MetadataAssetCatalogue } from '../modules/digital-delivery/adapters/metadata-asset-catalogue'
import { DIGITAL_DELIVERY_GRANTED } from '../modules/digital-delivery/ports'
import type { DigitalAsset } from '../modules/digital-delivery/ports'

/**
 * The orchestration: order → assets → grants → Medusa fulfillment → event.
 *
 * This lives in a workflow rather than in the fulfillment provider because it
 * spans four modules (Product, digital-delivery, Fulfillment, Event) and because
 * it needs compensation. A grant handed out for an order whose fulfillment then
 * failed to create is exactly the half-delivered state a rollback exists to
 * prevent.
 *
 * Idempotent end to end: re-running it on an already-granted order creates
 * nothing and emits nothing.
 */

// ---------------------------------------------------------------------------

const resolveDigitalItemsStep = createStep(
  'resolve-digital-items',
  async (input: { orderId: string }, { container }) => {
    const query = container.resolve('query')

    const { data: [order] } = await query.graph({
      entity: 'order',
      fields: [
        'id',
        'email',
        'customer_id',
        'items.id',
        'items.title',
        'items.variant_id',
        'items.product_id',
        'items.product_title',
        'items.variant_title',
        // Needed to decide whether Medusa can create a fulfillment at all: with
        // no shipping method there is no service zone to fulfil against.
        'shipping_methods.id',
      ],
      filters: { id: input.orderId },
    })

    if (!order) return new StepResponse({ order: null, assets: [] as DigitalAsset[] })

    const catalogue = new MetadataAssetCatalogue(
      container.resolve(Modules.PRODUCT),
      container.resolve('logger')
    )

    const assets = await catalogue.resolve(order.items ?? [])

    return new StepResponse({ order, assets })
  }
)

/**
 * Creates the grants.
 *
 * Compensation deletes ONLY the grants this invocation created — tracked by id,
 * not by order — so a retry that finds five existing grants and adds a sixth
 * does not roll back the five that were already earned.
 */
const createDigitalGrantsStep = createStep(
  'create-digital-grants',
  async (
    input: {
      order: { id: string; email: string; customer_id: string | null } | null
      assets: DigitalAsset[]
    },
    { container }
  ) => {
    if (!input.order || !input.assets.length) {
      return new StepResponse({ grantIds: [] as string[] }, { createdIds: [] as string[] })
    }

    const delivery = container.resolve(DIGITAL_DELIVERY_MODULE) as any

    const before = await delivery.listDigitalGrants({ order_id: input.order.id })
    const knownIds = new Set(before.map((grant: any) => String(grant.id)))

    const after = await delivery.grantForOrder(
      input.assets.map((asset) => ({
        ...asset,
        orderId: input.order!.id,
        customerId: input.order!.customer_id,
        email: input.order!.email,
      }))
    )

    const createdIds = after
      .map((grant: any) => String(grant.id))
      .filter((id: string) => !knownIds.has(id))

    return new StepResponse(
      { grantIds: after.map((grant: any) => String(grant.id)) },
      { createdIds }
    )
  },
  async (compensation, { container }) => {
    if (!compensation?.createdIds?.length) return
    const delivery = container.resolve(DIGITAL_DELIVERY_MODULE) as any
    await delivery.deleteDigitalGrants(compensation.createdIds)
  }
)

const emitGrantedStep = createStep(
  'emit-digital-delivery-granted',
  async (input: { orderId: string; grantIds: string[] }, { container }) => {
    if (!input.grantIds.length) return new StepResponse(void 0)

    await container.resolve(Modules.EVENT_BUS).emit({
      name: DIGITAL_DELIVERY_GRANTED,
      data: { order_id: input.orderId, grant_ids: input.grantIds },
    })

    return new StepResponse(void 0)
  }
)

/**
 * Records a Medusa fulfillment for the digital lines — BEST EFFORT.
 *
 * This step swallows its own failures on purpose, and that is the most important
 * decision in this file.
 *
 * `createOrderFulfillmentWorkflow` derives the fulfilling location by walking
 * shipping method → shipping option → service zone → fulfillment set. A digital
 * order legitimately has no shipping method, so that walk hits `undefined` and
 * throws `Cannot read properties of undefined (reading 'service_zone')`.
 *
 * Run as a normal step, that failure rolled back the workflow — which DELETED
 * the grants the buyer had just paid for. The essential thing (the grant) was
 * made to depend on the cosmetic one (an admin-facing fulfillment record). That
 * is backwards: a buyer must get their file whether or not Medusa's fulfillment
 * bookkeeping succeeds.
 *
 * So the failure is logged and the workflow continues. The cost is an order that
 * reads as unfulfilled in admin, which is visible and fixable by hand. The
 * alternative cost was a paid order with no download, which is neither.
 */
const recordFulfillmentStep = createStep(
  'record-digital-fulfillment',
  async (
    input: { orderId: string; lineItemIds: string[]; hasShipping: boolean },
    { container }
  ) => {
    if (!input.lineItemIds.length) return new StepResponse(void 0)

    const logger = container.resolve('logger')
    const query = container.resolve('query')

    /**
     * Supply the location EXPLICITLY rather than letting Medusa derive it.
     *
     * Normally it walks shipping method → shipping option → service zone →
     * fulfillment set → location. A digital order has no shipping method, so
     * that walk hits `undefined` and throws on `service_zone`.
     *
     * Medusa Admin's own fulfil form offers Location as a field and treats
     * Shipping method as optional, so a `location_id` is a first-class input.
     * That is the honest fix: an ebook genuinely has no shipping method, and
     * inventing a ₱0 shipping option purely to satisfy a lookup would put a
     * fake delivery line on every digital order.
     */
    let locationId = ''

    try {
      const { data: locations } = await query.graph({
        entity: 'stock_location',
        fields: ['id', 'name'],
        pagination: { take: 1 },
      })
      locationId = String(locations?.[0]?.id ?? '')
    } catch (error) {
      logger.warn(`[digital] could not list stock locations: ${(error as Error)?.message ?? error}`)
    }

    if (!locationId && !input.hasShipping) {
      logger.info(
        `[digital] order ${input.orderId}: no stock location and no shipping method, so Medusa ` +
          'has nothing to fulfil against. Grants are issued; the order stays unfulfilled in ' +
          'admin. Create a stock location to have digital orders show as fulfilled.'
      )
      return new StepResponse(void 0)
    }

    try {
      await createOrderFulfillmentWorkflow(container).run({
        input: {
          order_id: input.orderId,
          items: input.lineItemIds.map((id) => ({ id, quantity: 1 })),
          ...(locationId ? { location_id: locationId } : {}),
          // The buyer is told by the digital_delivery.granted email, which
          // carries the actual links. Medusa's generic shipment notice would be
          // a second, emptier email about the same event.
          no_notification: true,
        } as any,
      })

      logger.info(`[digital] recorded fulfillment for ${input.orderId} at location ${locationId}`)
    } catch (error) {
      logger.warn(
        `[digital] could not record a Medusa fulfillment for ${input.orderId}: ` +
          `${(error as Error)?.message ?? error}. Downloads are unaffected.`
      )
    }

    return new StepResponse(void 0)
  }
)

// ---------------------------------------------------------------------------

export const fulfilDigitalItemsWorkflow = createWorkflow(
  'fulfil-digital-items',
  (input: { orderId: string }) => {
    const resolved = resolveDigitalItemsStep(input)

    const granted = createDigitalGrantsStep({
      order: resolved.order,
      assets: resolved.assets,
    })

    /**
     * Emitted BEFORE the fulfillment record, so the buyer's email does not
     * depend on Medusa's bookkeeping either.
     */
    emitGrantedStep({ orderId: input.orderId, grantIds: granted.grantIds })

    recordFulfillmentStep(
      transform({ input, resolved }, (data) => ({
        orderId: data.input.orderId,
        lineItemIds: (data.resolved.assets ?? []).map((asset: DigitalAsset) => asset.lineItemId),
        hasShipping: Boolean((data.resolved.order as any)?.shipping_methods?.length),
      }))
    )

    return new WorkflowResponse({ grantIds: granted.grantIds })
  }
)

export default fulfilDigitalItemsWorkflow
