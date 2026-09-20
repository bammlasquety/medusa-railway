import { model } from '@medusajs/framework/utils'

/**
 * A one-time, short-lived PIN that proves control of an email inbox before a
 * customer's password may be changed.
 *
 * Only an HMAC of the PIN is stored — keyed with JWT_SECRET and bound to the
 * email — so a database dump is not a list of working codes, and a 6-digit
 * space cannot be brute-forced offline without the key.
 */
export const PasswordResetCode = model
  .define('password_reset_code', {
    id: model.id({ prefix: 'pwrc' }).primaryKey(),
    email: model.text(),
    code_hash: model.text(),
    expires_at: model.dateTime(),
    attempts: model.number().default(0),
    consumed_at: model.dateTime().nullable(),
    requested_ip: model.text().nullable(),
  })
  .indexes([{ on: ['email', 'created_at'] }])

export default PasswordResetCode
