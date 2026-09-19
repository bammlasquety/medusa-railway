import { randomBytes } from "node:crypto"

import { loadEnv, defineConfig } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "production", process.cwd())

/**
 * Reads a signing secret, and refuses to invent one.
 *
 * `jwtSecret` and `cookieSecret` used to fall back to the string `"supersecret"`
 * — the placeholder shipped in the Medusa starter and in every fork of it,
 * including the template this deployment came from. It is public knowledge.
 *
 * With it in force, anyone can mint a customer JWT for any `actor_id` and:
 *
 *   - read any customer's order history, email and totals, and
 *   - pass the `ownsOrder` check on `/store/digital-downloads`, which mints
 *     working download links for every digital product ever sold here.
 *
 * The value on Railway is correct today. That is not what this guard is for. It
 * is for the next environment — a staging service, a second region, a fresh
 * deploy where someone forgets one variable — because the failure is SILENT. The
 * backend boots, logs nothing, serves traffic, and signs its tokens with a key
 * an attacker already has. There is no symptom to notice.
 *
 * So: throw. A backend that will not start is a five-minute outage with an error
 * message naming the variable. A backend that starts with a known signing key is
 * a breach you find out about from someone else.
 *
 * Development gets a random secret per boot rather than a constant. That keeps
 * `medusa develop` and `medusa db:generate` working on a machine with no
 * production secrets — the reason module registration is already conditional
 * below — while ensuring the dev key is never a value anyone can guess. Sessions
 * do not survive a restart locally, which is the correct trade.
 */
const PLACEHOLDER_SECRETS = new Set([
  "supersecret",
  "secret",
  "changeme",
  "change-me",
  "your-secret",
])

/** Matches `loadEnv` above, which already treats an unset NODE_ENV as
 *  production. Anything that is not explicitly development or test is held to
 *  production rules — the safe direction to be wrong in. */
const isDevLike = ["development", "test"].includes(process.env.NODE_ENV ?? "")

function requiredSecret(name: string): string {
  const value = (process.env[name] ?? "").trim()
  const usable = value.length >= 16 && !PLACEHOLDER_SECRETS.has(value.toLowerCase())

  if (usable) return value

  if (!isDevLike) {
    throw new Error(
      `[security] ${name} is ${value ? "a placeholder or too short" : "not set"}. ` +
        `It signs customer sessions, so a knowable value lets anyone forge a session ` +
        `for any customer and download every digital product in the store. ` +
        `Set it to at least 32 random bytes: \`openssl rand -hex 32\`. ` +
        `Refusing to start.`
    )
  }

  console.warn(
    `[security] ${name} is not set — using a random value for this process only. ` +
      `Sessions will not survive a restart. This is allowed in development and ` +
      `would abort the boot in any other environment.`
  )

  return randomBytes(32).toString("hex")
}

/**
 * Modules whose registration depends on whether their credentials exist.
 *
 * Medusa validates some provider options at REGISTRATION time, so an
 * unconfigured provider is not "inert" — it crashes boot, and it also breaks
 * `medusa db:generate`, which loads every registered module to read its models.
 * Registering conditionally means a machine without production secrets can still
 * generate migrations, and a half-configured deploy degrades instead of failing.
 */
const hasS3 = Boolean(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID)
const hasResend = Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM)

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    workerMode: (process.env.MEDUSA_WORKER_MODE as
      | "shared"
      | "worker"
      | "server") || "shared",
    http: {
      storeCors: process.env.STORE_CORS || "",
      adminCors: process.env.ADMIN_CORS || "",
      authCors: process.env.AUTH_CORS || "",
      jwtSecret: requiredSecret("JWT_SECRET"),
      cookieSecret: requiredSecret("COOKIE_SECRET"),
    },
  },
  admin: {
    // Leave empty so the admin Vite bundle uses same-origin relative URLs.
    // Setting an absolute fallback (e.g. http://localhost:9000) gets baked into
    // the bundle at `medusa build` time and breaks production logins with
    // "Failed to fetch" (mixed-content / cross-origin).
    backendUrl: process.env.BACKEND_URL || "",
    disable: process.env.DISABLE_MEDUSA_ADMIN === "true",
  },
  modules: [
    { key: "api_key", resolve: "@medusajs/medusa/api-key" },

    // -----------------------------------------------------------------------
    // Redis event bus + workflow engine — REQUIRED by the PayMongo webhook
    // (ADR 0003). Without them the event bus is in-memory: a queued webhook is
    // lost on redeploy and a worker-mode process never sees it.
    // `family: 0` because Railway's private network is IPv6-only.
    // -----------------------------------------------------------------------
    {
      resolve: "@medusajs/medusa/event-bus-redis",
      options: {
        redisUrl: process.env.REDIS_URL,
        redisOptions: { family: 0 },
        jobOptions: {
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86400, count: 5000 },
        },
      },
    },
    {
      resolve: "@medusajs/medusa/workflow-engine-redis",
      options: {
        redis: {
          url: process.env.REDIS_URL,
          redisUrl: process.env.REDIS_URL,
          options: { family: 0 },
        },
      },
    },

    // -----------------------------------------------------------------------
    // PayMongo webhook idempotency ledger — table `paymongo_events` (ADR 0003).
    // -----------------------------------------------------------------------
    { resolve: "./src/modules/paymongo-ledger" },

    // -----------------------------------------------------------------------
    // Payments — PayMongo Hosted Checkout. See docs/adr/0002.
    // Provider id is `pp_paymongo_paymongo`: pp_{identifier}_{id}.
    // -----------------------------------------------------------------------
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "./src/modules/paymongo",
            id: "paymongo",
            options: {
              secretKey: process.env.PAYMONGO_SECRET_KEY,
              webhookSecret: process.env.PAYMONGO_WEBHOOK_SECRET,
              // Default origin PayMongo returns the buyer to.
              storefrontUrl: process.env.STOREFRONT_URL,
              // Other storefronts allowed to request their own return origin, so
              // one Medusa can serve localhost and the deployed site at once.
              allowedReturnOrigins: (process.env.ALLOWED_RETURN_ORIGINS ?? "")
                .split(",")
                .map((origin) => origin.trim())
                .filter(Boolean),
            },
          },
        ],
      },
    },

    // -----------------------------------------------------------------------
    // Files — ONE provider only.
    //
    // This was registered twice (file-local AND file-s3). The File Module accepts
    // a single provider, so the duplicate key meant one silently won and which
    // one was anybody's guess. S3 is the intended destination; local is the
    // fallback until the S3 variables are set.
    // -----------------------------------------------------------------------
    hasS3
      ? {
          resolve: "@medusajs/medusa/file",
          options: {
            providers: [
              {
                resolve: "@medusajs/medusa/file-s3",
                id: "s3",
                options: {
                  // Public read URL for the bucket — persisted onto
                  // product.thumbnail, so it must be browser-facing.
                  file_url: process.env.S3_FILE_URL,
                  access_key_id: process.env.S3_ACCESS_KEY_ID,
                  secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
                  region: process.env.S3_REGION,
                  bucket: process.env.S3_BUCKET,
                  endpoint: process.env.S3_ENDPOINT,
                  additional_client_config: {
                    // REQUIRED for Supabase. Without it the SDK builds
                    // virtual-hosted URLs (bucket.host/…) and uploads fail.
                    forcePathStyle: true,
                  },
                },
              },
            ],
          },
        }
      : {
          resolve: "@medusajs/medusa/file",
          options: {
            providers: [
              {
                resolve: "@medusajs/medusa/file-local",
                id: "local",
                options: {
                  upload_dir: "static",
                  // Absolute and publicly reachable — never localhost, or the
                  // URL is persisted onto products pointing at nothing.
                  backend_url: `${process.env.MEDUSA_BACKEND_URL}/static`,
                },
              },
            ],
          },
        },

    // -----------------------------------------------------------------------
    // Digital delivery — grants, download tokens, redemption. See ADR 0001.
    // Owns data models, so it is the one module needing `db:generate`.
    // -----------------------------------------------------------------------
    {
      resolve: "./src/modules/digital-delivery",
      options: {
        supabase: {
          url: process.env.SUPABASE_URL,
          serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
        storefrontUrl: process.env.STOREFRONT_URL,
      },
    },

    // -----------------------------------------------------------------------
    // Fulfillment — `manual` must stay for physical goods; naming this module
    // replaces the default provider list rather than extending it.
    // -----------------------------------------------------------------------
    {
      resolve: "@medusajs/medusa/fulfillment",
      options: {
        providers: [
          { resolve: "@medusajs/medusa/fulfillment-manual", id: "manual" },
          { resolve: "./src/modules/digital-fulfillment", id: "digital" },
        ],
      },
    },

    // -----------------------------------------------------------------------
    // Notifications — Resend only once its credentials exist, so an
    // unconfigured environment can still boot and still generate migrations.
    // -----------------------------------------------------------------------
    {
      resolve: "@medusajs/medusa/notification",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/notification-local",
            id: "local",
            options: { name: "Local Notification Provider", channels: ["feed"] },
          },
          ...(hasResend
            ? [
                {
                  resolve: "./src/modules/resend",
                  id: "resend",
                  options: {
                    channels: ["email"],
                    apiKey: process.env.RESEND_API_KEY,
                    from: process.env.RESEND_FROM,
                  },
                },
              ]
            : []),
        ],
      },
    },
  ],
})
