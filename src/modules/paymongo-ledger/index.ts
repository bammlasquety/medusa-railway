import { Module } from '@medusajs/framework/utils'

import PaymongoLedgerService from './service'

export const PAYMONGO_LEDGER_MODULE = 'paymongo_ledger'

/**
 * A module of its own rather than state inside the payment provider.
 *
 * A provider registered under `payment.providers` is a service, not a module: it
 * gets no models, no migrations and no container of its own. The ledger needs
 * all three, and it also needs to outlive the provider — the delivery history of
 * a payment is still worth having after the provider is replaced.
 */
export default Module(PAYMONGO_LEDGER_MODULE, {
  service: PaymongoLedgerService,
})

export { PaymongoEvent } from './models/paymongo-event'
export { default as PaymongoLedgerService } from './service'
export * from './events'
