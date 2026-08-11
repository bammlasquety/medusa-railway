import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260811102012 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "digital_download_token" drop constraint if exists "digital_download_token_token_hash_unique";`);
    this.addSql(`alter table if exists "digital_grant" drop constraint if exists "digital_grant_order_id_line_item_id_unique";`);
    this.addSql(`create table if not exists "digital_grant" ("id" text not null, "order_id" text not null, "fulfillment_id" text null, "line_item_id" text not null, "variant_id" text not null, "product_id" text not null, "customer_id" text null, "email" text not null, "title" text not null, "storage_bucket" text not null, "storage_path" text not null, "file_name" text not null, "content_type" text not null default 'application/octet-stream', "max_downloads" integer not null default 5, "download_count" integer not null default 0, "expires_at" timestamptz not null, "revoked_at" timestamptz null, "last_downloaded_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "digital_grant_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_grant_deleted_at" ON "digital_grant" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_digital_grant_order_id_line_item_id_unique" ON "digital_grant" ("order_id", "line_item_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_grant_order_id" ON "digital_grant" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_grant_customer_id" ON "digital_grant" ("customer_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "digital_download_token" ("id" text not null, "token_hash" text not null, "purpose" text check ("purpose" in ('page', 'email')) not null default 'page', "expires_at" timestamptz not null, "used_at" timestamptz null, "issued_ip" text null, "grant_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "digital_download_token_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_digital_download_token_token_hash_unique" ON "digital_download_token" ("token_hash") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_download_token_grant_id" ON "digital_download_token" ("grant_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_download_token_deleted_at" ON "digital_download_token" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_download_token_expires_at" ON "digital_download_token" ("expires_at") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "digital_download_token" add constraint "digital_download_token_grant_id_foreign" foreign key ("grant_id") references "digital_grant" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "digital_download_token" drop constraint if exists "digital_download_token_grant_id_foreign";`);

    this.addSql(`drop table if exists "digital_grant" cascade;`);

    this.addSql(`drop table if exists "digital_download_token" cascade;`);
  }

}
