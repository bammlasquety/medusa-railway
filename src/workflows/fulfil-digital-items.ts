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
 * The orchestration: order → payment check → assets → grants → Medusa
 * fulfillment → event.
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

/**
 * The payment states a digital delivery may proceed on.
 *
 * PayMongo Hosted Checkout takes the money at the moment of payment, so a
 * genuinely paid order arrives here as `captured`. `authorized` is deliberately
 * NOT on this list: an authorisation is a promise, and a file, once downloaded,
 * cannot be un-downloaded when the promise is not kept.
 */
const DELIVERABLE_PAYMENT_STATUSES = ['captured', 'partially_captured']

/**
 * The escape hatch for the cases the subscriber's comment defends — a comp, a
 * bank transfer settled off-platform, an order an admin created by hand.
 *
 * It is metadata an operator sets ON PURPOSE, one order at a time, and it leaves
 * a trace in the order record explaining why an unpaid order was delivered. That
 * is the difference between an exception and a hole.
 */
const COMP_METADATA_FLAG = 'allow_unpaid_digital'

interface PaymentVerdict {
  ok: boolean
  status: string
  reason: string
}

function assessPaymentForDelivery(order: any): PaymentVerdict {
  const status = String(order?.payment_status ?? 'unknown')

  if (DELIVERABLE_PAYMENT_STATUSES.includes(status)) {
    return { ok: true, status, reason: '' }
  }

  const flag = (order?.metadata ?? {})[COMP_METADATA_FLAG]

  if (flag === true || String(flag ?? '').toLowerCase() === 'true') {
    return { ok: true, status, reason: `delivered unpaid by ${COMP_METADATA_FLAG}` }
  }

  return { ok: false, status, reason: `payment_status is "${status}"` }
}

// ---------------------------------------------------------------------------

const resolveDigitalItemsStep = createStep(
  'resolve-digital-items',
  async (input: { orderId: string }, { container }) => {
    const query = container.resolve('query')
    const logger = container.resolve('logger') as any

    const empty = {
      order: null,
      assets: [] as DigitalAsset[],
      lineItems: [] as Array<{ id: string; quantity: number }>,
      payment: { ok: false, status: 'unknown', reason: 'no order' } as PaymentVerdict,
    }

    const { data: [order] } = await query.graph({
      entity: 'order',
      fields: [
        'id',
        'email',
        'customer_id',
        // The gate. Without this field the workflow cannot tell a paid order
        // from a comped one from an abandoned one, and it delivers all three.
        'payment_status',
        'metadata',
        'items.id',
        'items.title',
        // Load-bearing: fulfilling `quantity: 1` of a line the buyer bought two
        // of leaves the order permanently `partially_fulfilled`.
        'items.quantity',
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

    if (!order) return new StepResponse(empty)

    const payment = assessPaymentForDelivery(order)

    /**
     * THE GATE.
     *
     * Everything below this line hands a customer a file they can keep. Nothing
     * below this line runs for an order that has not been paid for.
     *
     * It is checked here rather than in the subscriber on purpose: the
     * subscriber's job is "an order was placed", and it is also not the only
     * possible caller — an admin retrying delivery from the UI, or the reconcile
     * job, must be held to the same rule. A guard that lives in one caller is a
     * guard that a second caller forgets.
     */
    if (!payment.ok) {
      logger.error(
        `[digital] REFUSING to deliver order ${input.orderId}: ${payment.reason}. ` +
          `No grants, no email, no fulfillment. Set metadata ${COMP_METADATA_FLAG}=true ` +
          'on the order if this is a deliberate comp.'
      )

      return new StepResponse({ ...empty, order, payment })
    }

    if (payment.reason) {
      // A comp went out. Not an error, but never silent.
      logger.warn(`[digital] order ${input.orderId}: ${payment.reason} (${payment.status})`)
    }

    const catalogue = new MetadataAssetCatalogue(
      container.resolve(Modules.PRODUCT),
      container.resolve('logger')
    )

    const assets = await catalogue.resolve(order.items ?? [])

    /**
     * Quantities, carried alongside the assets rather than inside them.
     *
     * A DigitalAsset describes a FILE; how many of it the buyer bought is a
     * property of the order line, not of the file. Merging the two would mean a
     * grant needing to know about quantity, which it does not — one grant covers
     * the line however many were bought.
     */
    const quantityOf = new Map<string, number>(
      ((order.items ?? []) as any[]).map((item) => [
        String(item?.id ?? ''),
        Math.max(1, Number(item?.quantity ?? 1) || 1),
      ])
    )

    const lineItems = [...new Set(assets.map((asset) => asset.lineItemId))].map((id) => ({
      id,
      quantity: quantityOf.get(id) ?? 1,
    }))

    return new StepResponse({ order, assets, lineItems, payment })
  }
)

/**
 * Records WHY an order was refused, on the order itself.
 *
 * Medusa has no "partially unfulfilled" status to set — `fulfillment_status` is
 * derived from the fulfillments that exist, and a refused order correctly has
 * none, so it reads as `not_fulfilled`. That is the honest state; what it does
 * not do is say why, and "unfulfilled" looks identical whether delivery was
 * blocked, errored, or never attempted.
 *
 * So the reason goes in metadata, where it is visible in admin next to the order
 * and queryable in SQL. An operator who fixes the payment can clear the flag and
 * re-run delivery; nothing here is a dead end.
 */
const recordDeliveryBlockStep = createStep(
  'record-digital-delivery-block',
  async (
    input: { orderId: string; blocked: boolean; status: string; reason: string },
    { container }
  ) => {
    if (!input.blocked) return new StepResponse(void 0)

    const logger = container.resolve('logger') as any

    try {
      const query = container.resolve('query')

      const { data: [order] } = await query.graph({
        entity: 'order',
        fields: ['id', 'metadata'],
        filters: { id: input.orderId },
      })

      await (container.resolve(Modules.ORDER) as any).updateOrders([
        {
          id: input.orderId,
          metadata: {
            ...((order as any)?.metadata ?? {}),
            digital_delivery_status: 'blocked_unpaid',
            digital_delivery_blocked_reason: input.reason,
            digital_delivery_payment_status: input.status,
            digital_delivery_blocked_at: new Date().toISOString(),
          },
        },
      ])
    } catch (error) {
      logger.warn(
        `[digital] could not record the delivery block on ${input.orderId}: ` +
          `${(error as Error)?.message ?? error}`
      )
    }

    return new StepResponse(void 0)
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
    input: {
      orderId: string
      lineItems: Array<{ id: string; quantity: number }>
      hasShipping: boolean
    },
    { container }
  ) => {
    if (!input.lineItems.length) return new StepResponse(void 0)

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
          /**
           * The REAL quantity, not 1.
           *
           * This was `quantity: 1` for every line, which is correct exactly when
           * the buyer bought one of everything. Buy two copies of an ebook and
           * Medusa records 1 of 2 fulfilled and computes `partially_fulfilled`
           * forever — on an order where both copies were delivered, because a
           * grant covers the line regardless of quantity. Months of "why is this
           * order stuck at partially fulfilled" trace back to this one literal.
           */
          items: input.lineItems.map((line) => ({ id: line.id, quantity: line.quantity })),
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

    /**
     * Runs first and unconditionally. A refused order must be explained even
     * though — especially though — nothing else in this workflow will do
     * anything for it.
     */
    recordDeliveryBlockStep(
      transform({ input, resolved }, (data) => ({
        orderId: data.input.orderId,
        blocked: Boolean((data.resolved as any)?.order) && !(data.resolved as any)?.payment?.ok,
        status: String((data.resolved as any)?.payment?.status ?? 'unknown'),
        reason: String((data.resolved as any)?.payment?.reason ?? ''),
      }))
    )

    /**
     * With the gate closed, `assets` is empty — so the three steps below are all
     * no-ops by their own guards. The refusal is enforced by there being nothing
     * to act on, not by a branch that a later edit could forget to add.
     */
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
        lineItems: ((data.resolved as any)?.lineItems ?? []) as Array<{
          id: string
          quantity: number
        }>,
        hasShipping: Boolean((data.resolved as any)?.order?.shipping_methods?.length),
      }))
    )

    return new WorkflowResponse({ grantIds: granted.grantIds })
  }
)

export default fulfilDigitalItemsWorkflow
