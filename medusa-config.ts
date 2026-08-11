import { loadEnv, defineConfig } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "production", process.cwd())

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
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
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
