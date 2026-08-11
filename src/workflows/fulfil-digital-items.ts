import { Modules } from '@medusajs/framework/utils'
import { createOrderFulfillmentWorkflow } from '@medusajs/medusa/core-flows'
import {
  StepResponse,
  WorkflowResponse,
  createStep,
  createWorkflow,
  transform,
  when,
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
     * Only touch Medusa's fulfillment machinery when there is something digital
     * to fulfil. A physical-only order must fall straight through — creating an
     * empty fulfillment would mark a seedling order as shipped.
     */
    const hasDigital = transform({ resolved }, (data) => (data.resolved.assets?.length ?? 0) > 0)

    when({ hasDigital }, (data) => data.hasDigital).then(() => {
      const items = transform({ resolved }, (data) =>
        data.resolved.assets.map((asset: DigitalAsset) => ({
          id: asset.lineItemId,
          quantity: 1,
        }))
      )

      createOrderFulfillmentWorkflow.runAsStep({
        input: transform({ input, items }, (data) => ({
          order_id: data.input.orderId,
          items: data.items,
          // The buyer is told by the digital_delivery.granted email, which
          // carries the actual links. Medusa's generic shipment notice would be
          // a second, emptier email about the same event.
          no_notification: true,
        })),
      })
    })

    emitGrantedStep({ orderId: input.orderId, grantIds: granted.grantIds })

    return new WorkflowResponse({ grantIds: granted.grantIds })
  }
)

export default fulfilDigitalItemsWorkflow
