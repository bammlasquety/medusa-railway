import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/** password_reset_code — see models/password-reset-code.ts. Hand-written; mirrors the model. */
export class Migration20260920010000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "password_reset_code" ("id" text not null, "email" text not null, "code_hash" text not null, "expires_at" timestamptz not null, "attempts" integer not null default 0, "consumed_at" timestamptz null, "requested_ip" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "password_reset_code_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_password_reset_code_email_created_at" ON "password_reset_code" ("email", "created_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_password_reset_code_deleted_at" ON "password_reset_code" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "password_reset_code" cascade;`);
  }

}
