import type {
  CreateFulfillmentResult,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
  Logger,
} from '@medusajs/framework/types'
import { AbstractFulfillmentProviderService, MedusaError } from '@medusajs/framework/utils'

/**
 * A fulfillment provider for goods that have no carrier, no address and no
 * transit time.
 *
 * It is thin ON PURPOSE, and that is the load-bearing decision of ADR 0001.
 * Medusa's own documentation draws the line: a provider "is not responsible for
 * managing fulfillment concepts within Medusa". Two framework constraints make
 * that more than a style preference —
 *
 *   1. A module provider receives the *Fulfillment* module's scoped container.
 *      It cannot reliably resolve the digital-delivery module, the Product
 *      module or the event bus, which is everything granting a download needs.
 *   2. Provider methods are not workflow steps, so anything done here has no
 *      compensation. A grant created here could not be rolled back if the
 *      surrounding fulfillment then failed.
 *
 * So granting lives in `fulfilDigitalItemsWorkflow`, and this class answers a
 * narrower question: what does "fulfilled" MEAN for a file? Answer — it happened
 * the moment the order was placed, there is nothing to ship, and there is
 * nothing to return.
 */

const OPTION_ID = 'digital-delivery'

type InjectedDependencies = {
  logger: Logger
}

class DigitalFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = 'digital'

  protected readonly logger_: Logger

  constructor({ logger }: InjectedDependencies) {
    super()
    this.logger_ = logger
  }

  /**
   * One static option. There is no carrier API to enumerate services from — the
   * "service" is a signed URL — so this is a constant rather than a fetch.
   */
  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      {
        id: OPTION_ID,
        name: 'Digital delivery',
        is_return: false,
      } as FulfillmentOption,
    ]
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return data?.id === OPTION_ID
  }

  /**
   * Nothing to validate and nothing to enrich: there is no third-party booking
   * reference to attach. Returning `data` unchanged is the honest answer, and it
   * keeps whatever the storefront chose to put there.
   */
  async validateFulfillmentData(
    _optionData: Record<string, unknown>,
    data: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return data ?? {}
  }

  /**
   * A file has no distance and no weight. The shipping option must therefore be
   * created with `price_type: "flat"` at 0 — returning `false` here makes Medusa
   * reject a `calculated` option at creation time rather than failing later,
   * mid-checkout, where the customer would see it.
   */
  async canCalculate(): Promise<boolean> {
    return false
  }

  /**
   * Delivery is instantaneous, so the fulfillment is born delivered. Medusa
   * stores what this returns on `fulfillment.data`; the grant ids are written by
   * the workflow afterwards via an update, because they do not exist yet at this
   * point in the lifecycle.
   */
  async createFulfillment(
    _data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, 'fulfillment'>>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    _fulfillment: Partial<Omit<FulfillmentDTO, 'provider_id' | 'data' | 'items'>>
  ): Promise<CreateFulfillmentResult> {
    const deliveredAt = new Date().toISOString()

    this.logger_.info(
      `[digital] fulfilling ${items.length} digital item(s) for order ${order?.id ?? 'unknown'}`
    )

    return {
      data: {
        channel: 'digital',
        option_id: OPTION_ID,
        delivered_at: deliveredAt,
        // No labels: there is no parcel, so `labels` is deliberately absent
        // rather than an empty array pretending a shipment exists.
      },
      labels: [],
    }
  }

  /**
   * Cancelling a digital fulfillment is meaningful — it should stop future
   * downloads — but the revocation itself belongs to the delivery module, which
   * this provider cannot reach (see the class comment).
   *
   * The `order.canceled` / `fulfillment.canceled` subscriber does the revoking.
   * This method exists to make that hand-off explicit rather than silent.
   */
  async cancelFulfillment(data: Record<string, unknown>): Promise<any> {
    this.logger_.info(
      `[digital] fulfillment canceled; revocation is handled by the fulfillment.canceled subscriber`
    )
    return { ...data, canceled_at: new Date().toISOString() }
  }

  /**
   * Loudly unsupported. You cannot un-download a file, and silently accepting a
   * return would leave an admin believing they had recovered something.
   */
  async createReturnFulfillment(): Promise<CreateFulfillmentResult> {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Digital items cannot be returned. Revoke the download grant instead, then refund the order.'
    )
  }

  async getFulfillmentDocuments(): Promise<never[]> {
    return []
  }

  async getReturnDocuments(): Promise<never[]> {
    return []
  }

  async getShipmentDocuments(): Promise<never[]> {
    return []
  }
}

export default DigitalFulfillmentProviderService
