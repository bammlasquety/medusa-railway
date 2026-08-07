import { ModuleProvider, Modules } from '@medusajs/framework/utils'

import PaymongoProviderService from './service'

/**
 * Registered under the Payment module's `providers` array, which makes the
 * provider id `pp_paymongo_paymongo` (`pp_{identifier}_{config id}`). That
 * string is what the storefront passes when creating a payment session, and
 * getting it wrong produces a confusing "provider not found".
 */
export default ModuleProvider(Modules.PAYMENT, {
  services: [PaymongoProviderService],
})
