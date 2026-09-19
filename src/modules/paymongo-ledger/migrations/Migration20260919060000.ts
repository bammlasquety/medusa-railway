import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * paymongo_events — the PayMongo webhook idempotency ledger (ADR 0003).
 *
 * Hand-written because `db:generate` could not run offline; it mirrors
 * `models/paymongo-event.ts`. The unique index on `event_id` deliberately has
 * NO `where deleted_at is null`: soft-deleting a processed event must never
 * make the same payment processable again.
 */
export class Migration20260919060000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "paymongo_events" ("id" text not null, "event_id" text not null, "event_type" text not null, "livemode" boolean not null default false, "status" text not null default 'claimed', "attempts" integer not null default 0, "last_error" text null, "reference" text null, "cart_id" text null, "payment_session_id" text null, "paymongo_payment_id" text null, "order_id" text null, "payload" jsonb not null, "processed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "paymongo_events_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_paymongo_events_event_id_unique" ON "paymongo_events" ("event_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_paymongo_events_status" ON "paymongo_events" ("status");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_paymongo_events_reference" ON "paymongo_events" ("reference");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_paymongo_events_order_id" ON "paymongo_events" ("order_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_paymongo_events_deleted_at" ON "paymongo_events" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "paymongo_events" cascade;`);
  }

}
