/**
 * Store bootstrap: currencies, region, sales channel, tax region, stock
 * location, shipping profiles, shipping options, product types and a
 * publishable API key.
 *
 *   npx medusa exec ./src/scripts/seed.ts
 *
 * On Railway, run it from the service Console after the first deploy has
 * migrated the database. `start.sh` deliberately does NOT call this — seeding
 * is a decision, not a boot step, and a seed that runs on every restart is a
 * seed that eventually runs against production by accident.
 *
 * IDEMPOTENT. Every step looks the object up first and skips it if present, so
 * a re-run after a partial failure completes the rest rather than duplicating
 * what already worked. Nothing here updates an existing object: if a value is
 * wrong, change it in the admin or delete the object and re-run. That is the
 * deliberate trade — a seed that overwrites silently reverts admin edits someone
 * made on purpose.
 *
 * PHYSICAL SHIPPING IS OFF. `SEED_PHYSICAL_SHIPPING` below is false because the
 * store sells digital goods today. The physical path is written and tested-
 * shaped, not deleted — flip the flag and edit PHYSICAL_OPTIONS when the first
 * seedling ships. Read the comment on the flag before you do: an unpriced or
 * missing physical option is a 409 at checkout, not a warning.
 */
import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createApiKeysWorkflow,
  createProductTypesWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows"

// ---------------------------------------------------------------------------
// Everything you would want to change lives in this block.
// ---------------------------------------------------------------------------

/** Lower-case, as Medusa stores it. The storefront's checkout hard-rejects any
 *  cart not in PHP (`session.post.ts`), so a second currency here would create
 *  a region no buyer can complete an order in. */
const CURRENCY = "php"

const REGION_NAME = "Philippines"
const REGION_COUNTRIES = ["ph"]

const SALES_CHANNEL_NAME = "Default Sales Channel"

const STOCK_LOCATION = {
  name: "Dendrotonics HQ",
  address: {
    address_1: "Set the real address in Settings -> Locations",
    city: "Quezon City",
    country_code: "ph",
    postal_code: "1100",
  },
}

const PRODUCT_TYPES = ["Ebook", "Seedling", "Agarwood Product", "Merchandise"]

const PUBLISHABLE_KEY_TITLE = "Storefront"

/**
 * The payment provider id is `pp_{identifier}_{config id}` — `paymongo` on both
 * halves, per `medusa-config.ts` and `cartCompletion.ts`. The region is created
 * with whichever of these the running process actually has registered: a
 * provider whose credentials are absent is not in the container, and naming it
 * here would abort the whole seed.
 */
const WANTED_PAYMENT_PROVIDERS = ["pp_paymongo_paymongo"]

/**
 * Digital delivery. `digital_digital` is `{static identifier}_{config id}` from
 * `src/modules/digital-fulfillment` — the `fp_` prefix in that module's comment
 * is the awilix container key, not the id stored on the provider row.
 *
 * `price_type: "flat"` at 0 is required, not a convenience: the provider's
 * `canCalculate()` returns false, so Medusa rejects a `calculated` option at
 * creation time. `data.id` must equal the provider's own OPTION_ID or
 * `validateOption` fails mid-checkout.
 */
const DIGITAL_PROVIDER_ID = "digital_digital"
const DIGITAL_OPTION_DATA_ID = "digital-delivery"

/**
 * Physical shipping. OFF.
 *
 * Turning this on is a two-part commitment. The storefront picks the cheapest
 * option *that has a price in the cart's currency* for each shipping profile,
 * and treats an unpriced option as broken rather than free — so every option
 * below must carry a PHP price. If a physical product is ever in a cart with no
 * priced option available, `ensureShippingMethod` throws a 409 the buyer sees.
 */
// Enabled per run, not by editing this file:
//   SEED_PHYSICAL_SHIPPING=true npx medusa exec ./src/scripts/seed.ts
// Idempotent — on an already-seeded lane it only adds what is missing.
const SEED_PHYSICAL_SHIPPING = process.env.SEED_PHYSICAL_SHIPPING === "true"
const PHYSICAL_PROVIDER_ID = "manual_manual"
const PHYSICAL_OPTIONS = [
  { name: "Standard Delivery", code: "standard", amount: 200 },
]

// ---------------------------------------------------------------------------

export default async function seed({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const link = container.resolve(ContainerRegistrationKeys.LINK)

  const created: string[] = []
  const skipped: string[] = []

  const note = (verb: "created" | "skipped", what: string) => {
    ;(verb === "created" ? created : skipped).push(what)
    logger.info(`[seed] ${verb === "created" ? "+" : "="} ${what}`)
  }

  /** First row matching `filters`, or undefined. Keeps every lookup below to one line. */
  const findOne = async (
    entity: string,
    filters: Record<string, unknown>,
    fields: string[] = ["id"]
  ): Promise<any | undefined> => {
    const { data } = await query.graph({ entity, fields, filters })
    return data?.[0]
  }

  // -- 1. Sales channel ------------------------------------------------------
  // First, because the store, the stock location and the API key all point at it.

  let salesChannel = await findOne("sales_channel", { name: SALES_CHANNEL_NAME }, ["id", "name"])

  if (salesChannel) {
    note("skipped", `sales channel "${SALES_CHANNEL_NAME}"`)
  } else {
    const { result } = await createSalesChannelsWorkflow(container).run({
      input: { salesChannelsData: [{ name: SALES_CHANNEL_NAME }] },
    })
    salesChannel = result[0]
    note("created", `sales channel "${SALES_CHANNEL_NAME}"`)
  }

  // -- 2. Tax region ---------------------------------------------------------
  // Created with NO default rate on purpose. PH VAT is 12% and retail prices here
  // are quoted VAT-inclusive, so attaching a 12% rate would add it a second time
  // on top of the price the customer already saw. Set the rate in the admin only
  // if you switch to tax-exclusive pricing.

  const existingTaxRegion = await findOne("tax_region", { country_code: "ph" })

  if (existingTaxRegion) {
    note("skipped", "tax region PH")
  } else {
    await createTaxRegionsWorkflow(container).run({
      input: [{ country_code: "ph" }],
    })
    note("created", "tax region PH")
  }

  // -- 3. Region -------------------------------------------------------------

  let region = await findOne("region", { name: REGION_NAME }, ["id", "name", "currency_code"])

  if (region) {
    note("skipped", `region "${REGION_NAME}"`)
  } else {
    // Only name providers that are actually registered in this process.
    const { data: providers } = await query.graph({
      entity: "payment_provider",
      fields: ["id", "is_enabled"],
    })
    const availableIds = new Set((providers ?? []).map((p: any) => p.id))
    const paymentProviders = WANTED_PAYMENT_PROVIDERS.filter((id) => availableIds.has(id))

    for (const missing of WANTED_PAYMENT_PROVIDERS.filter((id) => !availableIds.has(id))) {
      logger.warn(
        `[seed] payment provider ${missing} is not registered in this process, so the ` +
          `region is being created without it. That usually means PAYMONGO_SECRET_KEY is ` +
          `unset here. Add the provider to the region in Settings -> Regions once it is.`
      )
    }

    const { result } = await createRegionsWorkflow(container).run({
      input: {
        regions: [
          {
            name: REGION_NAME,
            currency_code: CURRENCY,
            countries: REGION_COUNTRIES,
            payment_providers: paymentProviders,
            // Off: with no tax rate configured there is nothing to calculate, and
            // leaving it on invites a silent 12% appearing the day someone adds one.
            automatic_taxes: false,
          },
        ],
      },
    })
    region = result[0]
    note("created", `region "${REGION_NAME}" (${CURRENCY.toUpperCase()})`)
  }

  // -- 4. Stock location -----------------------------------------------------

  let stockLocation = await findOne("stock_location", { name: STOCK_LOCATION.name }, ["id", "name"])

  if (stockLocation) {
    note("skipped", `stock location "${STOCK_LOCATION.name}"`)
  } else {
    const { result } = await createStockLocationsWorkflow(container).run({
      input: { locations: [{ name: STOCK_LOCATION.name, address: STOCK_LOCATION.address }] },
    })
    stockLocation = result[0]
    note("created", `stock location "${STOCK_LOCATION.name}"`)

    await linkSalesChannelsToStockLocationWorkflow(container).run({
      input: { id: stockLocation.id, add: [salesChannel.id] },
    })
    note("created", "stock location -> sales channel link")
  }

  // -- 5. Fulfillment providers on the location ------------------------------
  // Without this link the provider's options never appear for carts fulfilled
  // from this location, and `listCartOptions` returns an empty array.

  const providerIds = [DIGITAL_PROVIDER_ID]
  if (SEED_PHYSICAL_SHIPPING) providerIds.push(PHYSICAL_PROVIDER_ID)

  for (const providerId of providerIds) {
    try {
      await link.create({
        [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
        [Modules.FULFILLMENT]: { fulfillment_provider_id: providerId },
      })
      note("created", `location -> fulfillment provider ${providerId}`)
    } catch (error) {
      // The link table has a unique constraint on the pair, so a re-run lands here.
      note("skipped", `location -> fulfillment provider ${providerId}`)
    }
  }

  // -- 6. Shipping profiles --------------------------------------------------
  // Two, and the split matters: the storefront adds one shipping method per
  // profile represented in the cart. A digital-only cart must not be asked to
  // pay physical postage, and a mixed cart needs both.

  const ensureProfile = async (name: string, type: string) => {
    const found = await findOne("shipping_profile", { name }, ["id", "name"])
    if (found) {
      note("skipped", `shipping profile "${name}"`)
      return found
    }
    const { result } = await createShippingProfilesWorkflow(container).run({
      input: { data: [{ name, type }] },
    })
    note("created", `shipping profile "${name}"`)
    return result[0]
  }

  const digitalProfile = await ensureProfile("Digital", "digital")
  const defaultProfile = await ensureProfile("Default", "default")

  // -- 7. Fulfillment set + service zone -------------------------------------
  // The service zone is what makes an option reachable for a PH address. No zone,
  // no options, and the failure looks like "no delivery option is available".

  const FULFILLMENT_SET_NAME = "Philippines Delivery"
  const SERVICE_ZONE_NAME = "Philippines"

  const fulfillmentModuleService = container.resolve(Modules.FULFILLMENT)

  let fulfillmentSet = await findOne(
    "fulfillment_set",
    { name: FULFILLMENT_SET_NAME },
    ["id", "name", "service_zones.id", "service_zones.name"]
  )

  if (fulfillmentSet) {
    note("skipped", `fulfillment set "${FULFILLMENT_SET_NAME}"`)
  } else {
    fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
      name: FULFILLMENT_SET_NAME,
      type: "shipping",
      service_zones: [
        {
          name: SERVICE_ZONE_NAME,
          geo_zones: REGION_COUNTRIES.map((country_code) => ({
            country_code,
            type: "country" as const,
          })),
        },
      ],
    })
    note("created", `fulfillment set "${FULFILLMENT_SET_NAME}" + service zone`)

    await link.create({
      [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
      [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
    })
    note("created", "location -> fulfillment set link")
  }

  const serviceZoneId = fulfillmentSet.service_zones?.[0]?.id

  if (!serviceZoneId) {
    throw new Error(
      `[seed] fulfillment set "${FULFILLMENT_SET_NAME}" has no service zone. Delete it in ` +
        `Settings -> Locations and re-run, or add a zone covering ${REGION_COUNTRIES.join(", ")}.`
    )
  }

  // -- 8. Shipping options ---------------------------------------------------

  const shippingRules = [
    { attribute: "enabled_in_store", value: "true", operator: "eq" as const },
    { attribute: "is_return", value: "false", operator: "eq" as const },
  ]

  const ensureShippingOption = async (input: {
    name: string
    code: string
    amount: number
    providerId: string
    profileId: string
    data?: Record<string, unknown>
  }) => {
    const found = await findOne("shipping_option", { name: input.name }, ["id", "name"])
    if (found) {
      note("skipped", `shipping option "${input.name}"`)
      return
    }

    await createShippingOptionsWorkflow(container).run({
      input: [
        {
          name: input.name,
          price_type: "flat",
          provider_id: input.providerId,
          service_zone_id: serviceZoneId,
          shipping_profile_id: input.profileId,
          data: input.data,
          type: { label: input.name, description: input.name, code: input.code },
          // Both entries on purpose. The currency price is the fallback; the
          // region price is what a PH cart actually resolves, and an option with
          // neither is the "unpriced option" the storefront refuses to use.
          prices: [
            { currency_code: CURRENCY, amount: input.amount },
            { region_id: region.id, amount: input.amount },
          ],
          rules: shippingRules,
        },
      ],
    })
    note("created", `shipping option "${input.name}" (${input.amount === 0 ? "free" : `PHP ${input.amount}`})`)
  }

  await ensureShippingOption({
    name: "Digital Delivery",
    code: "digital",
    amount: 0,
    providerId: DIGITAL_PROVIDER_ID,
    profileId: digitalProfile.id,
    data: { id: DIGITAL_OPTION_DATA_ID },
  })

  if (SEED_PHYSICAL_SHIPPING) {
    for (const option of PHYSICAL_OPTIONS) {
      await ensureShippingOption({
        name: option.name,
        code: option.code,
        amount: option.amount,
        providerId: PHYSICAL_PROVIDER_ID,
        profileId: defaultProfile.id,
      })
    }
  } else {
    logger.info(
      "[seed] physical shipping skipped (SEED_PHYSICAL_SHIPPING is false). A cart " +
        "containing a physical product will fail checkout with 409 until you enable it."
    )
  }

  // -- 9. Store: currencies and defaults -------------------------------------
  // Last, because it points at the region, sales channel and location above.

  const store = await findOne("store", {}, ["id", "name", "supported_currencies.*"])

  if (!store) {
    throw new Error("[seed] no store row found. Has `medusa db:migrate` run against this database?")
  }

  const hasCurrency = (store.supported_currencies ?? []).some(
    (currency: any) => currency?.currency_code === CURRENCY
  )

  if (hasCurrency) {
    note("skipped", `store currency ${CURRENCY.toUpperCase()} + defaults`)
  } else {
    await updateStoresWorkflow(container).run({
      input: {
        selector: { id: store.id },
        update: {
          supported_currencies: [{ currency_code: CURRENCY, is_default: true }],
          default_sales_channel_id: salesChannel.id,
          default_region_id: region.id,
          default_location_id: stockLocation.id,
        },
      },
    })
    note("created", `store currency ${CURRENCY.toUpperCase()} + defaults`)
  }

  // -- 10. Product types -----------------------------------------------------

  const { data: existingTypes } = await query.graph({
    entity: "product_type",
    fields: ["id", "value"],
  })
  const existingValues = new Set((existingTypes ?? []).map((type: any) => type.value))
  const missingTypes = PRODUCT_TYPES.filter((value) => !existingValues.has(value))

  for (const value of PRODUCT_TYPES.filter((v) => existingValues.has(v))) {
    note("skipped", `product type "${value}"`)
  }

  if (missingTypes.length) {
    await createProductTypesWorkflow(container).run({
      input: { product_types: missingTypes.map((value) => ({ value })) },
    })
    for (const value of missingTypes) note("created", `product type "${value}"`)
  }

  // -- 11. Publishable API key -----------------------------------------------
  // Per-database. A key from another environment will not authenticate here, which
  // is how a freshly seeded staging store ends up serving an empty catalogue.

  let apiKey = await findOne(
    "api_key",
    { title: PUBLISHABLE_KEY_TITLE, type: "publishable" },
    ["id", "title", "token"]
  )

  if (apiKey) {
    note("skipped", `publishable key "${PUBLISHABLE_KEY_TITLE}"`)
  } else {
    const { result } = await createApiKeysWorkflow(container).run({
      input: {
        api_keys: [{ title: PUBLISHABLE_KEY_TITLE, type: "publishable", created_by: "seed" }],
      },
    })
    apiKey = result[0]
    note("created", `publishable key "${PUBLISHABLE_KEY_TITLE}"`)

    await linkSalesChannelsToApiKeyWorkflow(container).run({
      input: { id: apiKey.id, add: [salesChannel.id] },
    })
    note("created", "publishable key -> sales channel link")
  }

  // -- Summary ---------------------------------------------------------------

  logger.info("")
  logger.info(`[seed] done — ${created.length} created, ${skipped.length} already present`)
  logger.info("")
  logger.info(`[seed] MEDUSA_PUBLISHABLE_KEY=${apiKey.token}`)
  logger.info("[seed] Put that in the storefront's environment for THIS lane.")

  if (!SEED_PHYSICAL_SHIPPING) {
    logger.info(
      "[seed] Next: add products in the admin. Digital products go on the " +
        `"${digitalProfile.name}" shipping profile; anything physical needs ` +
        "SEED_PHYSICAL_SHIPPING enabled first."
    )
  }
}
