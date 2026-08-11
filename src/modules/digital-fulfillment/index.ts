import { ModuleProvider, Modules } from '@medusajs/framework/utils'

import DigitalFulfillmentProviderService from './service'

/**
 * Registered under the Fulfillment module's `providers` array, which is what
 * makes the provider id `fp_digital_digital` (`fp_{identifier}_{config id}`).
 */
export default ModuleProvider(Modules.FULFILLMENT, {
  services: [DigitalFulfillmentProviderService],
})
