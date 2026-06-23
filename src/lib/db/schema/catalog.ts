import { pgTable, pgEnum, text, integer, boolean, uuid } from "drizzle-orm/pg-core";

export const addonPricing = pgEnum("addon_pricing", ["per_day", "per_rental"]);

/** Baby chairs, coolers, snorkel gear… (spec §5). `stock` null = unlimited;
 *  limited stock is enforced transactionally at booking time (Plan 04). */
export const addOns = pgTable("add_ons", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  priceCents: integer("price_cents").notNull(),
  pricing: addonPricing("pricing").notNull().default("per_rental"),
  category: text("category").notNull().default("equipment"),
  stock: integer("stock"),
  active: boolean("active").notNull().default(true),
});

export const insuranceTiers = pgTable("insurance_tiers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  dailyPriceCents: integer("daily_price_cents").notNull().default(0),
  coverage: text("coverage").notNull().default(""),
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
});
