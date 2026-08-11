import { Module } from '@medusajs/framework/utils'

import DigitalDeliveryModuleService from './service'

export const DIGITAL_DELIVERY_MODULE = 'digital_delivery'

export default Module(DIGITAL_DELIVERY_MODULE, {
  service: DigitalDeliveryModuleService,
})

export * from './ports'
export { default as DigitalDeliveryModuleService } from './service'
