import { model } from '@medusajs/framework/utils'

import { DownloadToken } from './download-token'

/**
 * The durable right to a file.
 *
 * One row per digital order line, created once by fulfilDigitalItemsWorkflow.
 * Everything that limits access lives here — expiry, cap, revocation — so
 * answering "may this person still download?" never requires looking anywhere
 * else.
 *
 * The storage coordinates are copied in rather than referenced. If the
 * catalogue's `file_path` is later corrected, an already-sold grant must keep
 * pointing at the file the buyer actually paid for.
 */
export const DigitalGrant = model
  .define('digital_grant', {
    id: model.id({ prefix: 'dgrant' }).primaryKey(),

    order_id: model.text(),
    // Nullable: an admin-created or comped order may have no fulfillment yet.
    fulfillment_id: model.text().nullable(),
    line_item_id: model.text(),
    variant_id: model.text(),
    product_id: model.text(),
    customer_id: model.text().nullable(),
    email: model.text(),

    title: model.text(),
    storage_bucket: model.text(),
    storage_path: model.text(),
    file_name: model.text(),
    content_type: model.text().default('application/octet-stream'),

    max_downloads: model.number().default(5),
    download_count: model.number().default(0),
    expires_at: model.dateTime(),
    revoked_at: model.dateTime().nullable(),
    last_downloaded_at: model.dateTime().nullable(),

    tokens: model.hasMany(() => DownloadToken, { mappedBy: 'grant' }),
  })
  /**
   * Idempotency, enforced by the database rather than by a check-then-insert
   * that races. The workflow is re-runnable (a replayed `order.placed`, an admin
   * retry) and must not hand out a second allowance for a line already granted.
   */
  .indexes([
    {
      on: ['order_id', 'line_item_id'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
    { on: ['order_id'] },
    { on: ['customer_id'] },
  ])
