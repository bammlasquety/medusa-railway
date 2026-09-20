import { Modules } from '@medusajs/framework/utils'

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const normaliseEmail = (value: unknown): string | null => {
  const email = String(value ?? '').trim().toLowerCase().slice(0, 254)
  return EMAIL.test(email) ? email : null
}

/**
 * Whether this email belongs to a CUSTOMER password login that the store may
 * reset.
 *
 * Medusa's emailpass identity is keyed by email and can be shared by a customer
 * and an admin user. Resetting it would change the ADMIN password too, from a
 * public storefront form. So an identity linked to an admin user is refused
 * here — admins use the admin's own reset — and the storefront still gets the
 * same generic answer.
 */
export async function isResettableCustomer(scope: any, email: string): Promise<boolean> {
  const auth = scope.resolve(Modules.AUTH) as any
  const [identity] = await auth.listProviderIdentities(
    { provider: 'emailpass', entity_id: email },
    { relations: ['auth_identity'] }
  )
  const meta = (identity?.auth_identity?.app_metadata ?? {}) as Record<string, unknown>
  return Boolean(identity && meta.customer_id && !meta.user_id)
}
