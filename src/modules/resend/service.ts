import type {
  Logger,
  ProviderSendNotificationDTO,
  ProviderSendNotificationResultsDTO,
} from '@medusajs/framework/types'
import { AbstractNotificationProviderService, MedusaError } from '@medusajs/framework/utils'

import { digitalDownloadsReady } from './templates/digital-downloads-ready'

/**
 * Resend notification provider.
 *
 * Templates are rendered here as plain functions rather than fetched from
 * Resend's dashboard: the download links are per-order secrets, so the template
 * has to be composed server-side anyway, and keeping it in the repo means the
 * email is code-reviewed and versioned with the feature that sends it.
 */

export interface ResendOptions {
  apiKey: string
  from: string
  replyTo?: string
  channels?: string[]
}

type InjectedDependencies = {
  logger: Logger
}

type Template = (data: Record<string, any>) => { subject: string; html: string; text: string }

const TEMPLATES: Record<string, Template> = {
  'digital-downloads-ready': digitalDownloadsReady,
}

class ResendNotificationProviderService extends AbstractNotificationProviderService {
  static identifier = 'resend'

  protected readonly logger_: Logger
  protected readonly options_: ResendOptions

  constructor({ logger }: InjectedDependencies, options: ResendOptions) {
    super()
    this.logger_ = logger
    this.options_ = options
  }

  static validateOptions(options: Record<any, any>) {
    if (!options.apiKey) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Resend provider requires `apiKey`.')
    }
    if (!options.from) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Resend provider requires `from` — a verified sender on your Resend domain.'
      )
    }
  }

  async send(
    notification: ProviderSendNotificationDTO
  ): Promise<ProviderSendNotificationResultsDTO> {
    const template = TEMPLATES[notification.template]

    if (!template) {
      // Fail loudly. Silently sending nothing means a customer who paid never
      // hears from you, and nothing in the logs says why.
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Resend provider has no template named "${notification.template}".`
      )
    }

    const { subject, html, text } = template(notification.data ?? {})

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options_.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: notification.from ?? this.options_.from,
        to: [notification.to],
        ...(this.options_.replyTo ? { reply_to: this.options_.replyTo } : {}),
        subject: notification.content?.subject ?? subject,
        html: notification.content?.html ?? html,
        text: notification.content?.text ?? text,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string }

    if (!response.ok) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Resend rejected the message (${response.status}): ${body?.message ?? 'unknown error'}`
      )
    }

    return { id: body.id }
  }
}

export default ResendNotificationProviderService
