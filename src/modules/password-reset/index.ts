import { Module } from '@medusajs/framework/utils'

import PasswordResetModuleService from './service'

export const PASSWORD_RESET_MODULE = 'password_reset'

export default Module(PASSWORD_RESET_MODULE, {
  service: PasswordResetModuleService,
})

export { default as PasswordResetModuleService } from './service'
