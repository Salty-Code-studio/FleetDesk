import { pgTable, pgEnum, text, integer, boolean, timestamp, uuid, jsonb, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const vehicleStatus = pgEnum("vehicle_status", ["active", "maintenance", "retired"]);
export const blockType = pgEnum("block_type", ["maintenance", "carwash", "cleaning", "out_of_service", "other"]);

/** Mirrors Phase 1's fleet.js 1:1 (spec §12) — seeding from it is a copy. */
export const vehicles = pgTable("vehicles", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  plate: text("plate").notNull().unique(), // registration; the row ID on the ops board
  class: text("class").notNull(),
  name: text("name").notNull(),
  seats: integer("seats").notNull(),
  transmission: text("transmission").notNull(),
  ac: boolean("ac").notNull().default(true),
  doors: integer("doors").notNull(),
  photos: jsonb("photos").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  priceDayCents: integer("price_day_cents").notNull(),
  priceWeekCents: integer("price_week_cents").notNull(),
  priceMonthCents: integer("price_month_cents").notNull(),
  depositCents: integer("deposit_cents"), // null until owner confirms per class (spec §16)
  status: vehicleStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Admin-placed out-of-service windows (cleaning, repairs). End exclusive, [) like bookings. */
export const availabilityBlocks = pgTable("availability_blocks", {
  id: uuid("id").defaultRandom().primaryKey(),
  vehicleId: uuid("vehicle_id").notNull().references(() => vehicles.id, { onDelete: "cascade" }),
  startAt: timestamp("start_at", { withTimezone: true, mode: "string" }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true, mode: "string" }).notNull(),
  type: blockType("type").notNull().default("other"),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check("availability_blocks_dates", sql`${t.endAt} > ${t.startAt}`)]);
